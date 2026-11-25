import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { formatMoney } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import type { Tx } from '../db/client.ts';
import {
  allocations,
  beneficiaries,
  salaryAccounts,
  transactions,
  transferAttempts,
  transfers,
} from '../db/schema.ts';
import { ProviderError } from '../lib/errors.ts';
import type { TransferResult } from '../ports/payments.ts';
import { audit } from './audit.ts';
import { raiseIssue, resolveIssue } from './issues.ts';
import { enqueue } from './jobs.ts';
import { credit, debit, PLATFORM, platformAccount, post } from './ledger.ts';
import { notify } from './notifications.ts';
import { refreshExecution } from './splits.ts';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];
/** How long a submitted reference may be missing at the provider before it is sent again. */
const ABSENT_GRACE_MS = 30_000;
const OPEN = ['queued', 'in_flight', 'unknown', 'retrying'];

type TransferRow = typeof transfers.$inferSelect;
type AttemptRow = typeof transferAttempts.$inferSelect;

const later = (ctx: Ctx, ms: number) => new Date(ctx.now().getTime() + ms);

function schedule(ctx: Ctx, ex: Tx | Ctx['db'], transferId: string, delayMs: number) {
  return enqueue(
    ex,
    'transfer.process',
    { transferId },
    { dedupeKey: `transfer:${transferId}`, runAt: later(ctx, delayMs), maxAttempts: 30 },
  );
}

/**
 * Takes the one live attempt for a transfer, making it if needed, and records that it is about to be sent. The
 * mark is committed before any network call, so after a crash we know to look the reference up, not resend it.
 */
async function claimAttempt(
  ctx: Ctx,
  transferId: string,
): Promise<{ transfer: TransferRow; attempt: AttemptRow; firstSend: boolean } | null> {
  return ctx.db.transaction(async (tx) => {
    const [transfer] = await tx.select().from(transfers).where(eq(transfers.id, transferId)).for('update');
    if (!transfer || !OPEN.includes(transfer.status)) return null;
    let [attempt] = await tx
      .select()
      .from(transferAttempts)
      .where(and(eq(transferAttempts.transferId, transferId), sql`status not in ('failed','reversed')`));
    if (!attempt) {
      const attemptNo = transfer.attemptCount + 1;
      [attempt] = await tx
        .insert(transferAttempts)
        .values({ transferId, attemptNo, reference: `psp-${transferId}-${attemptNo}` })
        .returning();
      await tx.update(transfers).set({ attemptCount: attemptNo }).where(eq(transfers.id, transferId));
    }
    const firstSend = attempt!.submittedAt === null;
    if (firstSend) {
      [attempt] = await tx
        .update(transferAttempts)
        .set({ submittedAt: ctx.now(), status: 'submitted' })
        .where(eq(transferAttempts.id, attempt!.id))
        .returning();
      if (transfer.status === 'queued')
        await tx.update(transfers).set({ status: 'in_flight' }).where(eq(transfers.id, transferId));
    }
    return { transfer, attempt: attempt!, firstSend };
  });
}

/**
 * Moves one transfer forward. Safe to call any number of times, concurrently, and after a crash at any point:
 * a reference that was ever sent is looked up before it is sent again, resending reuses the same reference (the
 * provider's idempotency key), and a new reference is made only after the provider says the last one failed.
 */
export async function processTransfer(ctx: Ctx, transferId: string): Promise<void> {
  const claimed = await claimAttempt(ctx, transferId);
  if (!claimed) return;
  const { transfer, attempt, firstSend } = claimed;

  if (!firstSend) {
    try {
      return await applyResult(ctx, attempt.reference, await ctx.payments.getTransfer(attempt.reference));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.kind !== 'not_found') return markUnknown(ctx, transfer, attempt, error);
      if (ctx.now().getTime() - attempt.submittedAt!.getTime() < ABSENT_GRACE_MS)
        return schedule(ctx, ctx.db, transferId, ABSENT_GRACE_MS);
    }
  }

  try {
    const result = await ctx.payments.initiateTransfer({
      reference: attempt.reference,
      amount: transfer.amount,
      recipientCode: transfer.recipientCode,
      narration: transfer.narration,
    });
    await applyResult(ctx, attempt.reference, result);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const duplicate =
      /reference/i.test(error.message) && /(exist|duplicate|unique|already)/i.test(error.message);
    if (error.kind === 'unknown' || duplicate) return markUnknown(ctx, transfer, attempt, error);
    if (error.kind === 'throttled') return schedule(ctx, ctx.db, transferId, 60_000);
    if (/balance is not enough|insufficient/i.test(error.message)) {
      await raiseIssue(ctx.db, {
        kind: 'provider_balance_low',
        severity: 'high',
        subject: transferId,
        detail: `${formatMoney(transfer.amount)} is waiting for funds at the provider`,
      });
      return schedule(ctx, ctx.db, transferId, 10 * 60_000);
    }
    await applyResult(
      ctx,
      attempt.reference,
      {
        reference: attempt.reference,
        outcome: 'failed',
        reason: error.message,
        amount: transfer.amount,
        fee: 0n,
      },
      { retryable: false },
    );
  }
}

async function markUnknown(
  ctx: Ctx,
  transfer: TransferRow,
  attempt: AttemptRow,
  error: ProviderError,
): Promise<void> {
  ctx.log.warn({ err: error, reference: attempt.reference }, 'transfer outcome unknown, will look it up');
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(transfers)
      .set({ status: 'unknown', lastCheckedAt: ctx.now() })
      .where(and(eq(transfers.id, transfer.id), inArray(transfers.status, OPEN)));
    await schedule(ctx, tx, transfer.id, 45_000);
  });
}

/** Applies what the provider says about one attempt. Repeated and out-of-order answers change nothing twice. */
export async function applyResult(
  ctx: Ctx,
  attemptReference: string,
  result: TransferResult,
  options: { retryable?: boolean } = {},
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(transferAttempts)
      .where(eq(transferAttempts.reference, attemptReference));
    if (!found) {
      await raiseIssue(tx, {
        kind: 'unknown_transfer',
        severity: 'high',
        subject: attemptReference,
        detail: 'The provider reported a transfer we did not make',
      });
      return;
    }
    const [transfer] = await tx
      .select()
      .from(transfers)
      .where(eq(transfers.id, found.transferId))
      .for('update');
    const [attempt] = await tx
      .select()
      .from(transferAttempts)
      .where(eq(transferAttempts.id, found.id))
      .for('update');
    await tx.update(transfers).set({ lastCheckedAt: ctx.now() }).where(eq(transfers.id, transfer!.id));

    if (result.amount !== transfer!.amount) {
      await raiseIssue(tx, {
        kind: 'transfer_amount_mismatch',
        severity: 'critical',
        subject: attemptReference,
        detail: `Sent ${formatMoney(transfer!.amount)}, the provider shows ${formatMoney(result.amount)}`,
      });
      return;
    }
    if (result.blockedReason) {
      await raiseIssue(tx, {
        kind: 'transfer_blocked',
        severity: 'high',
        subject: attemptReference,
        detail: result.blockedReason,
      });
    }

    const settled = ['success', 'failed', 'reversed'].includes(attempt!.status);
    if (attempt!.status === 'success' && result.outcome === 'reversed')
      return reverse(ctx, tx, transfer!, attempt!, result);
    if (settled) {
      if (attempt!.status === 'failed' && result.outcome === 'success') {
        await raiseIssue(tx, {
          kind: 'paid_after_failure',
          severity: 'critical',
          subject: attemptReference,
          detail: 'The provider paid a transfer it had reported as failed. Check for a double payment.',
        });
      }
      return;
    }

    switch (result.outcome) {
      case 'pending':
        await tx
          .update(transferAttempts)
          .set({ status: 'pending', providerCode: result.providerCode ?? null })
          .where(eq(transferAttempts.id, attempt!.id));
        await tx.update(transfers).set({ status: 'in_flight' }).where(eq(transfers.id, transfer!.id));
        await tx
          .update(transactions)
          .set({ status: 'pending', providerReference: attemptReference })
          .where(eq(transactions.id, transfer!.transactionId));
        return schedule(ctx, tx, transfer!.id, 2 * 60_000);
      case 'success':
        return settle(ctx, tx, transfer!, attempt!, result);
      case 'failed':
        return fail(ctx, tx, transfer!, attempt!, result, options.retryable ?? true);
      case 'reversed':
        return reverse(ctx, tx, transfer!, attempt!, result);
    }
  });
}

async function context(tx: Tx, transfer: TransferRow) {
  const [row] = await tx
    .select({ transaction: transactions, beneficiary: beneficiaries, account: salaryAccounts })
    .from(transactions)
    .innerJoin(beneficiaries, eq(beneficiaries.id, transfer.beneficiaryId))
    .innerJoin(salaryAccounts, eq(salaryAccounts.userId, transfer.userId))
    .where(eq(transactions.id, transfer.transactionId));
  return row!;
}

async function settle(
  ctx: Ctx,
  tx: Tx,
  transfer: TransferRow,
  attempt: AttemptRow,
  result: TransferResult,
): Promise<void> {
  const { transaction, beneficiary } = await context(tx, transfer);
  const clearing = await platformAccount(tx, PLATFORM.clearing);
  const cash = await platformAccount(tx, PLATFORM.cash);
  const fees = await platformAccount(tx, PLATFORM.fees);
  await post(tx, {
    reference: `settle:${attempt.reference}`,
    type: 'transfer_settled',
    description: transaction.description,
    transactionId: transaction.id,
    postings: [
      debit(clearing, transfer.amount),
      debit(fees, result.fee),
      credit(cash, transfer.amount + result.fee),
    ],
  });
  await tx
    .update(transferAttempts)
    .set({ status: 'success', providerCode: result.providerCode ?? null })
    .where(eq(transferAttempts.id, attempt.id));
  await tx
    .update(transfers)
    .set({ status: 'success', completedAt: ctx.now() })
    .where(eq(transfers.id, transfer.id));
  await tx
    .update(transactions)
    .set({
      status: 'success',
      providerReference: attempt.reference,
      completedAt: ctx.now(),
      failureReason: null,
    })
    .where(eq(transactions.id, transaction.id));
  await tx.update(allocations).set({ status: 'success' }).where(eq(allocations.id, transfer.allocationId));
  await resolveIssue(tx, 'provider_balance_low', transfer.id);
  await resolveIssue(tx, 'transfer_blocked', attempt.reference);
  await audit(tx, {
    actor: { type: 'system' },
    userId: transfer.userId,
    action: 'transfer.succeeded',
    target: { type: 'transfer', id: transfer.id },
    metadata: { reference: attempt.reference },
  });
  await notify(tx, {
    userId: transfer.userId,
    type: 'disbursement_receipt',
    dedupeKey: `receipt:${transfer.id}`,
    severity: 'success',
    title: `Sent to ${beneficiary.name}`,
    body: `${formatMoney(transfer.amount)} was paid to ${transaction.destination.label}.`,
    link: `/transactions?open=${transaction.id}`,
    email: {
      pref: 'disbursement_receipt',
      content: {
        subject: `Receipt: ${formatMoney(transfer.amount)} to ${beneficiary.name}`,
        heading: 'Transfer receipt',
        paragraphs: ['This transfer was completed as part of your salary split.'],
        rows: [
          ['Amount', formatMoney(transfer.amount)],
          ['To', `${transaction.destination.label} (${transaction.destination.detail ?? ''})`],
          ['Reference', transaction.reference],
          ['Date', ctx.now().toUTCString()],
        ],
        button: {
          label: 'Download receipt',
          url: `${ctx.config.APP_URL}/transactions?open=${transaction.id}`,
        },
      },
    },
  });
  await refreshExecution(ctx, tx, transaction.executionId!);
}

async function fail(
  ctx: Ctx,
  tx: Tx,
  transfer: TransferRow,
  attempt: AttemptRow,
  result: TransferResult,
  retryable: boolean,
): Promise<void> {
  const { transaction, beneficiary } = await context(tx, transfer);
  const reason = result.reason?.slice(0, 200) ?? 'The bank did not accept this transfer';
  await tx
    .update(transferAttempts)
    .set({ status: 'failed', failureReason: reason, providerCode: result.providerCode ?? null })
    .where(eq(transferAttempts.id, attempt.id));
  await audit(tx, {
    actor: { type: 'system' },
    userId: transfer.userId,
    action: 'transfer.attempt_failed',
    target: { type: 'transfer', id: transfer.id },
    metadata: { reference: attempt.reference, reason },
  });

  if (retryable && attempt.attemptNo < MAX_ATTEMPTS) {
    await tx.update(transfers).set({ status: 'retrying' }).where(eq(transfers.id, transfer.id));
    await tx
      .update(transactions)
      .set({ status: 'retrying', failureReason: reason })
      .where(eq(transactions.id, transaction.id));
    await notify(tx, {
      userId: transfer.userId,
      type: 'transfer_retrying',
      dedupeKey: `retrying:${transfer.id}`,
      severity: 'warning',
      title: `Transfer to ${beneficiary.name} is being retried`,
      body: `${formatMoney(transfer.amount)} did not go through. We will try again. Your money is held safely until then.`,
      link: `/transactions?open=${transaction.id}`,
    });
    return schedule(ctx, tx, transfer.id, RETRY_DELAYS_MS[attempt.attemptNo - 1]!);
  }

  await release(tx, transfer, `release:${transfer.id}`);
  await tx
    .update(transfers)
    .set({ status: 'failed', completedAt: ctx.now() })
    .where(eq(transfers.id, transfer.id));
  await tx
    .update(transactions)
    .set({ status: 'failed', failureReason: reason, completedAt: ctx.now() })
    .where(eq(transactions.id, transaction.id));
  await tx
    .update(allocations)
    .set({ status: 'failed', failureReason: reason })
    .where(eq(allocations.id, transfer.allocationId));
  await alertFailed(ctx, tx, transfer, transaction, beneficiary.name, reason, 'failed');
  await refreshExecution(ctx, tx, transaction.executionId!);
}

/** Returns held money to the salary account with a journal that reverses the hold. */
async function release(tx: Tx, transfer: TransferRow, reference: string): Promise<void> {
  const { transaction, account } = await context(tx, transfer);
  await post(tx, {
    reference,
    type: 'transfer_released',
    description: `Returned: ${transaction.description}`,
    transactionId: transaction.id,
    reversesJournalReference: `hold:${transfer.allocationId}`,
    postings: [
      debit(await platformAccount(tx, PLATFORM.clearing), transfer.amount),
      credit(account.ledgerAccountId, transfer.amount),
    ],
  });
}

async function reverse(
  ctx: Ctx,
  tx: Tx,
  transfer: TransferRow,
  attempt: AttemptRow,
  result: TransferResult,
): Promise<void> {
  const { transaction, beneficiary, account } = await context(tx, transfer);
  const reason = result.reason?.slice(0, 200) ?? 'The bank returned this transfer';
  if (attempt.status === 'success') {
    await post(tx, {
      reference: `reversal:${attempt.reference}`,
      type: 'transfer_reversed',
      description: `Reversed: ${transaction.description}`,
      transactionId: transaction.id,
      reversesJournalReference: `settle:${attempt.reference}`,
      postings: [
        debit(await platformAccount(tx, PLATFORM.cash), transfer.amount),
        credit(account.ledgerAccountId, transfer.amount),
      ],
    });
  } else {
    await release(tx, transfer, `release:${transfer.id}`);
  }
  await tx
    .update(transferAttempts)
    .set({ status: 'reversed', failureReason: reason })
    .where(eq(transferAttempts.id, attempt.id));
  await tx
    .update(transfers)
    .set({ status: 'reversed', completedAt: ctx.now() })
    .where(eq(transfers.id, transfer.id));
  await tx
    .update(transactions)
    .set({ status: 'reversed', failureReason: reason, completedAt: ctx.now() })
    .where(eq(transactions.id, transaction.id));
  await tx
    .update(allocations)
    .set({ status: 'reversed', failureReason: reason })
    .where(eq(allocations.id, transfer.allocationId));
  await audit(tx, {
    actor: { type: 'system' },
    userId: transfer.userId,
    action: 'transfer.reversed',
    target: { type: 'transfer', id: transfer.id },
    metadata: { reference: attempt.reference, reason },
  });
  await alertFailed(ctx, tx, transfer, transaction, beneficiary.name, reason, 'reversed');
  await refreshExecution(ctx, tx, transaction.executionId!);
}

async function alertFailed(
  ctx: Ctx,
  tx: Tx,
  transfer: TransferRow,
  transaction: typeof transactions.$inferSelect,
  name: string,
  reason: string,
  outcome: 'failed' | 'reversed',
): Promise<void> {
  const what = outcome === 'failed' ? 'failed' : 'was reversed';
  await notify(tx, {
    userId: transfer.userId,
    type: `transfer_${outcome}`,
    dedupeKey: `transfer-${outcome}:${transfer.id}`,
    severity: 'error',
    title: `Transfer to ${name} ${what}`,
    body: `${formatMoney(transfer.amount)} is back in your salary account. You can run the split again.`,
    link: `/transactions?open=${transaction.id}`,
    email: {
      content: {
        subject: `Transfer to ${name} ${what}`,
        paragraphs: [
          'This transfer did not complete. The money is back in your salary account and nobody was paid.',
          'Check the account details, then use Run Now when you are ready.',
        ],
        rows: [
          ['Amount', formatMoney(transfer.amount)],
          ['Reason', reason],
          ['Reference', transaction.reference],
        ],
        button: {
          label: 'View transaction',
          url: `${ctx.config.APP_URL}/transactions?open=${transaction.id}`,
        },
      },
    },
  });
}

/** Queues a check for every transfer that has not settled and has not been looked at recently. */
export async function sweepOpenTransfers(ctx: Ctx): Promise<void> {
  const stale = later(ctx, -2 * 60_000);
  const open = await ctx.db
    .select({ id: transfers.id, status: transfers.status, updatedAt: transfers.updatedAt })
    .from(transfers)
    .where(
      or(
        and(
          inArray(transfers.status, ['queued', 'in_flight', 'unknown']),
          lt(transfers.updatedAt, stale),
          or(isNull(transfers.lastCheckedAt), lt(transfers.lastCheckedAt, stale)),
        ),
        and(eq(transfers.status, 'retrying'), lt(transfers.updatedAt, later(ctx, -15 * 60_000))),
      ),
    )
    .limit(200);
  for (const transfer of open) {
    await enqueue(
      ctx.db,
      'transfer.process',
      { transferId: transfer.id },
      { dedupeKey: `transfer:${transfer.id}`, maxAttempts: 30 },
    );
  }
}
