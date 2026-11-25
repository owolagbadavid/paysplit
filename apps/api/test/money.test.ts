import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocations,
  executions,
  ledgerEntries,
  ledgerJournals,
  reconciliationIssues,
  salaryPayments,
  transactions,
  transferAttempts,
  transfers,
} from '../src/db/schema.ts';
import { checkBooks, recoverPayIns } from '../src/modules/reconciliation.ts';
import { setRuleStatus } from '../src/modules/rules.ts';
import { creditPayIn } from '../src/modules/salary-payments.ts';
import { tick } from '../src/modules/scheduler.ts';
import { executionDetail, previewRunNow, runAutomaticSplit, runNow } from '../src/modules/splits.ts';
import { buildStatement } from '../src/modules/transactions.ts';
import { applyResult, processTransfer, sweepOpenTransfers } from '../src/modules/transfers.ts';
import { moveToSalary } from '../src/modules/wallets.ts';
import {
  addBeneficiary,
  addRule,
  addWallet,
  balances,
  createHarness,
  platform,
  verifiedUser,
  type Harness,
} from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const NAIRA = 100;
const salary = async (accountNumber: string, naira: number) => {
  const payIn = h.emulators.bankTransfer(accountNumber, naira * NAIRA);
  await h.webhook('charge.success', payIn.reference);
  await h.drain();
  return payIn;
};
const paymentFor = async (reference: string) =>
  (await h.ctx.db.select().from(salaryPayments).where(eq(salaryPayments.providerReference, reference)))[0]!;
const executionsOf = (userId: string) =>
  h.ctx.db.select().from(executions).where(eq(executions.userId, userId)).orderBy(executions.createdAt);
const allocationsOf = (userId: string) =>
  h.ctx.db
    .select()
    .from(allocations)
    .where(eq(allocations.userId, userId))
    .orderBy(allocations.createdAt, allocations.position);
const transferOf = async (userId: string) =>
  (await h.ctx.db.select().from(transfers).where(eq(transfers.userId, userId)))[0]!;
const attemptsOf = (transferId: string) =>
  h.ctx.db
    .select()
    .from(transferAttempts)
    .where(eq(transferAttempts.transferId, transferId))
    .orderBy(transferAttempts.attemptNo);
const key = () => `test-key-${crypto.randomUUID()}`;

async function expectSoundBooks() {
  const failed = (await checkBooks(h.ctx)).filter((c) => c.detail && c.severity !== 'info');
  expect(failed).toEqual([]);
}

describe('automatic split', () => {
  it('runs the brief’s example end to end and the books balance', async () => {
    const user = await verifiedUser(h);
    const tithe = await addBeneficiary(h, user, '0123456701', 'Church');
    const mother = await addBeneficiary(h, user, '0123456702', 'Mother');
    const brother = await addBeneficiary(h, user, '0123456703', 'Brother');
    const savings = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'beneficiary', id: tithe.id }, 'percentage', 1000, 1);
    await addRule(h, user, { type: 'beneficiary', id: mother.id }, 'fixed', 100_000 * NAIRA, 2);
    await addRule(h, user, { type: 'beneficiary', id: brother.id }, 'fixed', 50_000 * NAIRA, 3);
    await addRule(h, user, { type: 'wallet', id: savings.id }, 'fixed', 200_000 * NAIRA, 4);

    await salary(user.accountNumber, 600_000);

    expect(await balances(h, user.id)).toEqual({ salary: 190_000 * NAIRA, wallets: 200_000 * NAIRA });
    const [execution] = await executionsOf(user.id);
    expect(execution).toMatchObject({ status: 'successful', trigger: 'automatic' });
    const detail = await executionDetail(h.ctx, execution!.id, user.id);
    expect(detail).toMatchObject({
      toWallets: 200_000 * NAIRA,
      toBeneficiaries: 210_000 * NAIRA,
      remaining: 190_000 * NAIRA,
    });
    expect(h.emulators.transfers.size).toBe(3);
    await expectSoundBooks();
    expect(await platform(h, 'payout_clearing')).toBe(0);
    expect(h.outbox.map((m) => m.subject)).toEqual(
      expect.arrayContaining([
        'Your salary has arrived',
        'Split completed',
        'Receipt: ₦100,000.00 to Mother',
      ]),
    );
  });

  it('credits a salary once however many times its webhook arrives, even at the same moment', async () => {
    const user = await verifiedUser(h);
    const payIn = h.emulators.bankTransfer(user.accountNumber, 100_000 * NAIRA);
    const confirmed = await h.ctx.payments.getPayIn(payIn.reference);
    await Promise.all(Array.from({ length: 8 }, () => creditPayIn(h.ctx, confirmed)));
    for (let i = 0; i < 3; i++) await h.webhook('charge.success', payIn.reference);
    await h.drain();
    expect((await balances(h, user.id)).salary).toBe(100_000 * NAIRA);
    const rows = await h.ctx.db.select().from(transactions).where(eq(transactions.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('splits a salary once under concurrent triggers', async () => {
    const user = await verifiedUser(h);
    const wallet = await addWallet(h, user, 'Rent');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'percentage', 5000, 1);
    const payIn = h.emulators.bankTransfer(user.accountNumber, 100_000 * NAIRA);
    const paymentId = (await creditPayIn(h.ctx, await h.ctx.payments.getPayIn(payIn.reference)))!;
    await Promise.all(Array.from({ length: 10 }, () => runAutomaticSplit(h.ctx, paymentId)));
    await h.drain();
    expect(await executionsOf(user.id)).toHaveLength(1);
    expect(await balances(h, user.id)).toEqual({ salary: 50_000 * NAIRA, wallets: 50_000 * NAIRA });
  });

  it('does not split a second payment in the same pay cycle, and says so', async () => {
    const user = await verifiedUser(h);
    const wallet = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'fixed', 10_000 * NAIRA, 1);
    await salary(user.accountNumber, 100_000);
    const bonus = await salary(user.accountNumber, 40_000);
    expect((await paymentFor(bonus.reference)).splitState).toBe('held');
    expect(await executionsOf(user.id)).toHaveLength(1);
    expect(await balances(h, user.id)).toEqual({ salary: 130_000 * NAIRA, wallets: 10_000 * NAIRA });
  });

  it('skips what cannot be fully funded, carries on, and reports a partial split', async () => {
    const user = await verifiedUser(h);
    const a = await addWallet(h, user, 'A');
    const b = await addWallet(h, user, 'B');
    const c = await addWallet(h, user, 'C');
    await addRule(h, user, { type: 'wallet', id: a.id }, 'fixed', 70_000 * NAIRA, 1);
    await addRule(h, user, { type: 'wallet', id: b.id }, 'fixed', 40_000 * NAIRA, 2);
    await addRule(h, user, { type: 'wallet', id: c.id }, 'percentage', 3000, 3);
    await salary(user.accountNumber, 100_000);
    const rows = await allocationsOf(user.id);
    expect(rows.map((r) => [r.status, r.skipReason, Number(r.allocatedAmount)])).toEqual([
      ['success', null, 70_000 * NAIRA],
      ['skipped', 'insufficient_funds', 0],
      ['success', null, 30_000 * NAIRA],
    ]);
    expect(Number(rows[1]!.availableBefore)).toBe(30_000 * NAIRA);
    expect((await executionsOf(user.id))[0]!.status).toBe('partially_completed');
    expect((await balances(h, user.id)).salary).toBe(0);
  });

  it('keeps the salary whole with no active rules, and catches up when the split job was lost', async () => {
    const user = await verifiedUser(h);
    const none = await salary(user.accountNumber, 50_000);
    expect((await paymentFor(none.reference)).splitState).toBe('no_rules');

    const other = await verifiedUser(h);
    const wallet = await addWallet(h, other, 'Savings');
    await addRule(h, other, { type: 'wallet', id: wallet.id }, 'fixed', 5_000 * NAIRA, 1);
    const payIn = h.emulators.bankTransfer(other.accountNumber, 50_000 * NAIRA);
    await creditPayIn(h.ctx, await h.ctx.payments.getPayIn(payIn.reference));
    await h.ctx.db.execute(sql`delete from paysplit.jobs where type = 'split.automatic'`);
    expect(await tick(h.ctx)).toContain('catch-up-splits');
    await h.drain();
    expect((await balances(h, other.id)).wallets).toBe(5_000 * NAIRA);
  });

  it('recovers a salary whose webhook never arrived', async () => {
    const user = await verifiedUser(h);
    h.emulators.bankTransfer(user.accountNumber, 75_000 * NAIRA);
    expect(await recoverPayIns(h.ctx)).toBe(1);
    expect(await recoverPayIns(h.ctx)).toBe(0);
    expect((await balances(h, user.id)).salary).toBe(75_000 * NAIRA);
    await h.drain();
  });

  it('surfaces money that arrives for an unknown account instead of losing it', async () => {
    const payIn = h.emulators.bankTransfer('9999999999', 10_000 * NAIRA);
    await h.webhook('charge.success', payIn.reference);
    await h.drain();
    const [issue] = await h.ctx.db
      .select()
      .from(reconciliationIssues)
      .where(eq(reconciliationIssues.subject, payIn.reference));
    expect(issue).toMatchObject({ kind: 'unmatched_payin', status: 'open' });
  });
});

describe('transfers', () => {
  async function sendOne(accountNumber = '0123456711') {
    const user = await verifiedUser(h);
    const mum = await addBeneficiary(h, user, accountNumber);
    await addRule(h, user, { type: 'beneficiary', id: mum.id }, 'fixed', 20_000 * NAIRA, 1);
    const payIn = h.emulators.bankTransfer(user.accountNumber, 100_000 * NAIRA);
    const paymentId = (await creditPayIn(h.ctx, await h.ctx.payments.getPayIn(payIn.reference)))!;
    await runAutomaticSplit(h.ctx, paymentId);
    return { user, transfer: await transferOf(user.id), payIn, paymentId };
  }
  const paidCount = (transferId: string) =>
    [...h.emulators.transfers.values()].filter(
      (t) => t.reference.includes(transferId) && t.status === 'success',
    ).length;

  it('pays once when the answer is lost after the provider acted', async () => {
    const { user, transfer } = await sendOne();
    h.emulators.transferFaults.push('drop_after');
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('unknown');
    expect((await balances(h, user.id)).salary).toBe(80_000 * NAIRA);
    h.clock.advance(60_000);
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('success');
    expect(paidCount(transfer.id)).toBe(1);
    expect(await attemptsOf(transfer.id)).toHaveLength(1);
    await h.drain();
    await expectSoundBooks();
  });

  it('resends with the same reference when the request never arrived', async () => {
    const { user, transfer } = await sendOne();
    h.emulators.transferFaults.push('drop_before');
    await processTransfer(h.ctx, transfer.id);
    await processTransfer(h.ctx, transfer.id);
    expect(h.emulators.transfers.has(`psp-${transfer.id}-1`)).toBe(false);
    h.clock.advance(60_000);
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('success');
    expect(paidCount(transfer.id)).toBe(1);
    expect(await attemptsOf(transfer.id)).toHaveLength(1);
    await h.drain();
  });

  it('pays once when many workers process the same transfer together', async () => {
    const { transfer } = await sendOne();
    await Promise.all(Array.from({ length: 12 }, () => processTransfer(h.ctx, transfer.id)));
    h.clock.advance(60_000);
    await processTransfer(h.ctx, transfer.id);
    expect(paidCount(transfer.id)).toBe(1);
    const journals = await h.ctx.db
      .select()
      .from(ledgerJournals)
      .where(eq(ledgerJournals.reference, `settle:psp-${transfer.id}-1`));
    expect(journals).toHaveLength(1);
    await h.drain();
    await expectSoundBooks();
  });

  it('looks up, not resends, after a crash between marking and sending', async () => {
    const { user, transfer } = await sendOne();
    await h.ctx.db.insert(transferAttempts).values({
      transferId: transfer.id,
      attemptNo: 1,
      reference: `psp-${transfer.id}-1`,
      status: 'submitted',
      submittedAt: h.clock.now,
    });
    await h.ctx.db
      .update(transfers)
      .set({ status: 'in_flight', attemptCount: 1 })
      .where(eq(transfers.id, transfer.id));
    const before = h.emulators.state.transferPosts;
    await processTransfer(h.ctx, transfer.id);
    expect(h.emulators.state.transferPosts).toBe(before);
    h.clock.advance(60_000);
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('success');
    expect(paidCount(transfer.id)).toBe(1);
    await h.drain();
  });

  it('retries a definite failure with new references, then returns the money and tells the owner', async () => {
    const { user, transfer } = await sendOne('0123456700');
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('retrying');
    expect((await balances(h, user.id)).salary).toBe(80_000 * NAIRA);
    h.clock.advance(60_000);
    await processTransfer(h.ctx, transfer.id);
    h.clock.advance(300_000);
    await processTransfer(h.ctx, transfer.id);
    const attempts = await attemptsOf(transfer.id);
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'failed']);
    expect(new Set(attempts.map((a) => a.reference)).size).toBe(3);
    expect((await transferOf(user.id)).status).toBe('failed');
    expect((await balances(h, user.id)).salary).toBe(100_000 * NAIRA);
    expect((await executionsOf(user.id))[0]!.status).toBe('failed');
    await h.drain();
    expect(h.outbox.some((m) => m.subject === 'Transfer to Mum failed')).toBe(true);
    await expectSoundBooks();
  });

  it('keeps a pending transfer pending, holds the money, and settles on the webhook', async () => {
    const { user, transfer } = await sendOne('0123456799');
    await processTransfer(h.ctx, transfer.id);
    expect((await executionsOf(user.id))[0]!.status).toBe('pending');
    expect(await platform(h, 'payout_clearing')).toBe(20_000 * NAIRA);
    const reference = `psp-${transfer.id}-1`;
    h.emulators.setTransferStatus(reference, 'success');
    await h.webhook('transfer.success', reference);
    await h.webhook('transfer.success', reference);
    await h.drain();
    expect((await executionsOf(user.id))[0]!.status).toBe('successful');
    expect(await platform(h, 'payout_clearing')).toBe(0);
  });

  it('returns the money when a paid transfer is reversed, and ignores older news afterwards', async () => {
    const { user, transfer } = await sendOne();
    await processTransfer(h.ctx, transfer.id);
    const reference = `psp-${transfer.id}-1`;
    h.emulators.setTransferStatus(reference, 'reversed', 'Account closed');
    await h.webhook('transfer.reversed', reference);
    await h.drain();
    expect((await balances(h, user.id)).salary).toBe(100_000 * NAIRA);
    await applyResult(h.ctx, reference, { reference, outcome: 'success', amount: 20_000n * 100n, fee: 0n });
    expect((await transferOf(user.id)).status).toBe('reversed');
    expect((await balances(h, user.id)).salary).toBe(100_000 * NAIRA);
    await expectSoundBooks();
  });

  it('raises a critical issue when the provider reports a different amount, and settles nothing', async () => {
    const { user, transfer } = await sendOne('0123456799');
    await processTransfer(h.ctx, transfer.id);
    const reference = `psp-${transfer.id}-1`;
    await applyResult(h.ctx, reference, { reference, outcome: 'success', amount: 1n, fee: 0n });
    expect((await transferOf(user.id)).status).toBe('in_flight');
    const [issue] = await h.ctx.db
      .select()
      .from(reconciliationIssues)
      .where(eq(reconciliationIssues.subject, reference));
    expect(issue).toMatchObject({ kind: 'transfer_amount_mismatch', severity: 'critical' });
    h.emulators.setTransferStatus(reference, 'success');
    await h.webhook('transfer.success', reference);
    await h.drain();
  });

  it('waits for funds instead of failing when the provider balance is short', async () => {
    const { user, transfer } = await sendOne();
    h.emulators.transferFaults.push('insufficient_balance');
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('in_flight');
    h.clock.advance(11 * 60_000);
    await sweepOpenTransfers(h.ctx);
    await processTransfer(h.ctx, transfer.id);
    expect((await transferOf(user.id)).status).toBe('success');
    expect(paidCount(transfer.id)).toBe(1);
    await h.drain();
  });

  it('refuses a webhook whose signature does not match', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': 'a'.repeat(128) },
      payload: JSON.stringify({ event: 'charge.success', data: { reference: 'forged-reference' } }),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('run now', () => {
  it('funds only what the salary has not funded, and never pays a destination twice', async () => {
    const user = await verifiedUser(h);
    const mum = await addBeneficiary(h, user, '0123456721');
    const savings = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'beneficiary', id: mum.id }, 'fixed', 20_000 * NAIRA, 1);
    await salary(user.accountNumber, 100_000);
    expect(await previewRunNow(h.ctx, user)).toEqual([]);

    await addRule(h, user, { type: 'wallet', id: savings.id }, 'percentage', 1000, 2);
    const [option] = await previewRunNow(h.ctx, user);
    expect(option!.allocations.map((a) => [a.destination.name, a.allocated])).toEqual([
      ['Savings', 10_000 * NAIRA],
    ]);

    const request = { salaryPaymentId: option!.salaryPaymentId, planHash: option!.planHash };
    const idempotencyKey = key();
    const results = await Promise.allSettled([
      runNow(h.ctx, user, request, idempotencyKey, {}),
      runNow(h.ctx, user, request, idempotencyKey, {}),
      runNow(h.ctx, user, request, key(), {}),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.executionId);
    expect(new Set(fulfilled).size).toBe(1);
    expect(await balances(h, user.id)).toEqual({ salary: 70_000 * NAIRA, wallets: 10_000 * NAIRA });
    const manual = (await executionsOf(user.id)).filter((e) => e.trigger === 'manual');
    expect(manual).toHaveLength(1);
    expect(
      [...h.emulators.transfers.values()].filter(
        (t) => t.reason.includes('PaySplit') && t.status === 'success',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a plan that changed after review', async () => {
    const user = await verifiedUser(h);
    const a = await addWallet(h, user, 'A');
    const payIn = await salary(user.accountNumber, 50_000);
    const rule = await addRule(h, user, { type: 'wallet', id: a.id }, 'fixed', 10_000 * NAIRA, 1);
    const [option] = await previewRunNow(h.ctx, user);
    const b = await addWallet(h, user, 'B');
    await addRule(h, user, { type: 'wallet', id: b.id }, 'fixed', 5_000 * NAIRA, 1);
    await expect(
      runNow(
        h.ctx,
        user,
        { salaryPaymentId: option!.salaryPaymentId, planHash: option!.planHash },
        key(),
        {},
      ),
    ).rejects.toMatchObject({ code: 'plan_changed' });
    await setRuleStatus(h.ctx, user, rule.id, 'pause', {});
    expect((await previewRunNow(h.ctx, user))[0]!.allocations.map((x) => x.destination.name)).toEqual(['B']);
    expect(payIn).toBeTruthy();
  });

  it('retries a failed transfer’s share and never touches money moved back from a wallet', async () => {
    const user = await verifiedUser(h);
    const bad = await addBeneficiary(h, user, '0123456800', 'Landlord');
    const savings = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'beneficiary', id: bad.id }, 'fixed', 30_000 * NAIRA, 2);
    await addRule(h, user, { type: 'wallet', id: savings.id }, 'fixed', 70_000 * NAIRA, 1);
    const payIn = h.emulators.bankTransfer(user.accountNumber, 100_000 * NAIRA);
    await runAutomaticSplit(
      h.ctx,
      (await creditPayIn(h.ctx, await h.ctx.payments.getPayIn(payIn.reference)))!,
    );
    const transfer = await transferOf(user.id);
    for (const wait of [0, 60_000, 300_000]) {
      h.clock.advance(wait);
      await processTransfer(h.ctx, transfer.id);
    }
    await moveToSalary(h.ctx, user, savings.id, 50_000 * NAIRA, key(), {});
    const [option] = await previewRunNow(h.ctx, user);
    expect(option).toMatchObject({ available: 30_000 * NAIRA });
    expect(option!.allocations.map((a) => a.destination.name)).toEqual(['Landlord']);
    await h.drain();
  });
});

describe('wallet to salary account', () => {
  it('moves once per key, refuses more than the balance, and survives concurrent requests', async () => {
    const user = await verifiedUser(h);
    const wallet = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'fixed', 60_000 * NAIRA, 1);
    await salary(user.accountNumber, 100_000);
    const same = key();
    const [a, b] = await Promise.all([
      moveToSalary(h.ctx, user, wallet.id, 25_000 * NAIRA, same, {}),
      moveToSalary(h.ctx, user, wallet.id, 25_000 * NAIRA, same, {}),
    ]);
    expect(a).toEqual(b);
    await expect(moveToSalary(h.ctx, user, wallet.id, 1 * NAIRA, same, {})).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
    const racing = await Promise.allSettled(
      Array.from({ length: 5 }, () => moveToSalary(h.ctx, user, wallet.id, 20_000 * NAIRA, key(), {})),
    );
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balances(h, user.id)).toEqual({ salary: 85_000 * NAIRA, wallets: 15_000 * NAIRA });
  });
});

describe('ledger guards', () => {
  it('refuses edits, deletes, unbalanced journals and negative customer balances in the database itself', async () => {
    const message = (p: Promise<unknown>) =>
      p.then(
        () => 'allowed',
        (e) => String((e as { cause?: Error }).cause?.message ?? (e as Error).message),
      );
    expect(
      await message(
        h.ctx.db
          .update(ledgerEntries)
          .set({ amount: 1n })
          .where(sql`true`),
      ),
    ).toMatch(/append-only/);
    expect(await message(h.ctx.db.delete(ledgerJournals).where(sql`true`))).toMatch(/append-only/);
    const [account] = await h.ctx.db.execute<{ account_id: string }>(
      sql`select account_id from paysplit.account_balances where type = 'wallet' limit 1`,
    );
    expect(
      await message(
        h.ctx.db.transaction(async (tx) => {
          const [j] = await tx
            .insert(ledgerJournals)
            .values({ reference: key(), type: 'test', description: 'one-sided' })
            .returning();
          await tx
            .insert(ledgerEntries)
            .values({ journalId: j!.id, accountId: account!.account_id, direction: 'credit', amount: 100n });
        }),
      ),
    ).toMatch(/not balanced/);
    const [cash] = await h.ctx.db.execute<{ account_id: string }>(
      sql`select account_id from paysplit.account_balances where code = 'platform:provider_cash'`,
    );
    expect(
      await message(
        h.ctx.db.transaction(async (tx) => {
          const [j] = await tx
            .insert(ledgerJournals)
            .values({ reference: key(), type: 'test', description: 'overdraw' })
            .returning();
          await tx.insert(ledgerEntries).values([
            { journalId: j!.id, accountId: account!.account_id, direction: 'debit', amount: 9_999_999_999n },
            { journalId: j!.id, accountId: cash!.account_id, direction: 'credit', amount: 9_999_999_999n },
          ]);
        }),
      ),
    ).toMatch(/negative/);
    const [done] = await h.ctx.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.status, 'success')))
      .limit(1);
    expect(
      await message(
        h.ctx.db.update(transactions).set({ status: 'pending' }).where(eq(transactions.id, done!.id)),
      ),
    ).toMatch(/cannot go from/);
  });
});

describe('statements', () => {
  it('reconcile with the ledger: opening + in - out = closing, matching the balance', async () => {
    const user = await verifiedUser(h);
    const wallet = await addWallet(h, user, 'Savings');
    const mum = await addBeneficiary(h, user, '0123456731');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'percentage', 3333, 1);
    await addRule(h, user, { type: 'beneficiary', id: mum.id }, 'fixed', 10_000 * NAIRA, 2);
    await salary(user.accountNumber, 99_999);
    const today = new Date().toISOString().slice(0, 10);
    const period = {
      from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10),
    };
    const s = await buildStatement(h.ctx, user, { ...period, account: 'salary' });
    expect(s.opening + s.totalIn - s.totalOut).toBe(s.closing);
    expect(Number(s.closing)).toBe((await balances(h, user.id)).salary);
    const w = await buildStatement(h.ctx, user, { ...period, account: wallet.id });
    expect(Number(w.closing)).toBe((await balances(h, user.id)).wallets);
    const all = await buildStatement(h.ctx, user, { ...period, account: 'all' });
    expect(all.closing).toBe(s.closing + w.closing);
  });
});

it('leaves sound books after everything above', expectSoundBooks);
