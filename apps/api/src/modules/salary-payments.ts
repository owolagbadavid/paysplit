import { and, eq, isNotNull } from 'drizzle-orm';
import { formatMoney, payCycleFor } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { payinRuns, salaryAccounts, salaryPayments, transactions, users } from '../db/schema.ts';
import { reference } from '../lib/ids.ts';
import type { PayIn } from '../ports/payments.ts';
import { audit } from './audit.ts';
import { raiseIssue } from './issues.ts';
import { enqueue } from './jobs.ts';
import { credit, debit, PLATFORM, platformAccount, post } from './ledger.ts';
import { notify } from './notifications.ts';
import { lockSalaryAccount } from './salary-accounts.ts';

async function findReceiver(ctx: Ctx, payIn: PayIn) {
  const [run] = await ctx.db.select().from(payinRuns).where(eq(payinRuns.providerReference, payIn.reference));
  if (run) {
    const [account] = await ctx.db.select().from(salaryAccounts).where(eq(salaryAccounts.userId, run.userId));
    return account ? { account, run } : null;
  }
  if (payIn.channel !== 'dedicated_nuban') return null;
  const match = payIn.receiverAccountNumber
    ? eq(salaryAccounts.accountNumber, payIn.receiverAccountNumber)
    : payIn.customerCode
      ? and(
          eq(salaryAccounts.providerCustomerCode, payIn.customerCode),
          isNotNull(salaryAccounts.accountNumber),
        )
      : undefined;
  if (!match) return null;
  const found = await ctx.db
    .select()
    .from(salaryAccounts)
    .where(and(match, eq(salaryAccounts.provider, ctx.payments.name)))
    .limit(2);
  // Two matches would mean guessing whose money it is.
  return found.length === 1 ? { account: found[0]!, run: null } : null;
}

/**
 * Credits a salary the provider has confirmed. `payIn` must come from asking the provider, not from a webhook
 * body. Calling this any number of times for one provider reference credits it once.
 *
 * Returns the salary payment ID, or null when there was nothing to credit.
 */
export async function creditPayIn(ctx: Ctx, payIn: PayIn): Promise<string | null> {
  if (payIn.status !== 'success') {
    const [run] = await ctx.db
      .select()
      .from(payinRuns)
      .where(eq(payinRuns.providerReference, payIn.reference));
    if (run && payIn.status === 'failed' && run.status !== 'confirmed') {
      await ctx.db
        .update(payinRuns)
        .set({ status: 'failed', failureReason: 'The provider declined the pay-in' })
        .where(eq(payinRuns.id, run.id));
    }
    const [credited] = await ctx.db
      .select({ id: salaryPayments.id })
      .from(salaryPayments)
      .where(
        and(
          eq(salaryPayments.provider, ctx.payments.name),
          eq(salaryPayments.providerReference, payIn.reference),
        ),
      );
    if (credited && payIn.status === 'reversed') {
      await raiseIssue(ctx.db, {
        kind: 'payin_reversed',
        severity: 'critical',
        subject: payIn.reference,
        detail: 'A credited salary was reversed at the provider',
      });
    }
    return null;
  }

  const receiver = await findReceiver(ctx, payIn);
  if (!receiver) {
    if (payIn.channel === 'dedicated_nuban') {
      await raiseIssue(ctx.db, {
        kind: 'unmatched_payin',
        severity: 'high',
        subject: payIn.reference,
        detail: `${formatMoney(payIn.amount)} arrived for an account we do not know`,
      });
    }
    return null;
  }
  const { account, run } = receiver;
  if (payIn.currency !== 'NGN' || payIn.amount <= 0n) {
    await raiseIssue(ctx.db, {
      kind: 'unexpected_payin',
      severity: 'high',
      subject: payIn.reference,
      detail: `${payIn.amount} ${payIn.currency}`,
    });
    return null;
  }
  if (run && run.amount !== payIn.amount) {
    await raiseIssue(ctx.db, {
      kind: 'payin_amount_mismatch',
      severity: 'high',
      subject: payIn.reference,
      detail: `Requested ${formatMoney(run.amount)}, the provider confirmed ${formatMoney(payIn.amount)}`,
    });
  }

  return ctx.db.transaction(async (tx) => {
    await lockSalaryAccount(tx, account.userId);
    const [user] = await tx.select().from(users).where(eq(users.id, account.userId));
    const [payment] = await tx
      .insert(salaryPayments)
      .values({
        reference: reference('SAL', ctx.now()),
        userId: account.userId,
        salaryAccountId: account.id,
        provider: ctx.payments.name,
        providerReference: payIn.reference,
        amount: payIn.amount,
        providerFee: payIn.fee,
        channel: payIn.channel,
        senderName: payIn.senderName ?? (run ? 'PaySplit admin test' : null),
        senderBank: payIn.senderBank ?? null,
        source: run ? 'admin_test' : 'bank_transfer',
        payinRunId: run?.id ?? null,
        payCycle: run?.payCycle ?? payCycleFor(payIn.paidAt, user!.salaryDay, user!.timezone),
        paidAt: payIn.paidAt,
        confirmedAt: ctx.now(),
      })
      .onConflictDoNothing()
      .returning();
    if (!payment) {
      const [existing] = await tx
        .select({ id: salaryPayments.id })
        .from(salaryPayments)
        .where(
          and(
            eq(salaryPayments.provider, ctx.payments.name),
            eq(salaryPayments.providerReference, payIn.reference),
          ),
        );
      return existing?.id ?? null;
    }

    const [transaction] = await tx
      .insert(transactions)
      .values({
        reference: reference('PAY', ctx.now()),
        userId: account.userId,
        type: 'salary_received',
        status: 'success',
        amount: payIn.amount,
        description: `Salary from ${payment.senderName ?? user!.employer ?? 'employer'}`,
        category: 'salary',
        source: { label: payment.senderName ?? user!.employer ?? 'Employer', detail: payIn.senderBank },
        destination: {
          label: 'Salary account',
          detail: account.accountNumber ? `••••${account.accountNumber.slice(-4)}` : undefined,
        },
        salaryPaymentId: payment.id,
        providerReference: payIn.reference,
        isTest: payIn.isTest,
        completedAt: ctx.now(),
      })
      .returning();
    const cash = await platformAccount(tx, PLATFORM.cash);
    const fees = await platformAccount(tx, PLATFORM.fees);
    await post(tx, {
      reference: `salary:${ctx.payments.name}:${payIn.reference}`,
      type: 'salary_received',
      description: transaction!.description,
      transactionId: transaction!.id,
      postings: [
        debit(cash, payIn.amount - payIn.fee),
        debit(fees, payIn.fee),
        credit(account.ledgerAccountId, payIn.amount),
      ],
    });
    if (run)
      await tx
        .update(payinRuns)
        .set({ status: 'confirmed', failureReason: null })
        .where(eq(payinRuns.id, run.id));
    await audit(tx, {
      actor: { type: 'system' },
      userId: account.userId,
      action: 'salary.confirmed',
      target: { type: 'salary_payment', id: payment.id },
      metadata: { amount: Number(payIn.amount), source: payment.source, payCycle: payment.payCycle },
    });
    await notify(tx, {
      userId: account.userId,
      type: 'salary_received',
      dedupeKey: `salary:${payment.id}`,
      severity: 'success',
      title: 'Salary received',
      body: `${formatMoney(payIn.amount)} arrived in your salary account.`,
      link: `/transactions?open=${transaction!.id}`,
      email: {
        pref: 'salary_received',
        content: {
          subject: 'Your salary has arrived',
          paragraphs: ['Your salary is confirmed. We are applying your split rules now.'],
          rows: [
            ['Amount', formatMoney(payIn.amount)],
            ['Reference', transaction!.reference],
          ],
          button: { label: 'View details', url: `${ctx.config.APP_URL}/transactions` },
        },
      },
    });
    await enqueue(
      tx,
      'split.automatic',
      { salaryPaymentId: payment.id },
      { dedupeKey: `split:${payment.id}` },
    );
    return payment.id;
  });
}
