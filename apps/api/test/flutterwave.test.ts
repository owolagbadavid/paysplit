import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FlutterwaveProvider } from '../src/adapters/flutterwave.ts';
import { payinRuns, salaryAccounts, salaryPayments, transferAttempts, transfers } from '../src/db/schema.ts';
import { checkBooks, confirmPayIns, recoverPayIns } from '../src/modules/reconciliation.ts';
import { receivePaymentWebhook } from '../src/modules/webhooks.ts';
import { startFakeFlutterwave, type FakeFlutterwave } from './flutterwave-fake.ts';
import { addRule, addWallet, createHarness, verifiedUser, type Harness } from './harness.ts';
import { createBeneficiary } from '../src/modules/beneficiaries.ts';

const HASH = 'a-webhook-secret-hash-of-32-chars!';
let h: Harness;
let fake: FakeFlutterwave;
let flw: FlutterwaveProvider;

beforeAll(async () => {
  h = await createHarness();
  fake = await startFakeFlutterwave();
  flw = new FlutterwaveProvider({
    secretKey: 'FLWSECK_TEST-fake-X',
    webhookHash: HASH,
    baseUrl: fake.url,
    timeoutMs: 3000,
  });
  h.ctx.payments = flw;
});
afterAll(async () => {
  await fake.close();
  await h.close();
});
beforeEach(() => {
  fake.loseNextTransferAnswer = false;
});

const pay = async (userId: string, amount: bigint) => {
  const reference = `psi-${crypto.randomUUID()}`;
  await flw.submitTestPayIn({ reference, amount, email: 'a@example.com', metadata: {} });
  await h.ctx.db.insert(payinRuns).values({
    adminId: await adminId(),
    userId,
    amount,
    payCycle: '2026-11',
    provider: flw.name,
    providerReference: reference,
    status: 'awaiting_confirmation',
  });
  return reference;
};
let cachedAdmin: string | undefined;
async function adminId() {
  if (cachedAdmin) return cachedAdmin;
  const { admins } = await import('../src/db/schema.ts');
  const [row] = await h.ctx.db
    .insert(admins)
    .values({ authId: crypto.randomUUID(), email: 'a@admin.test', firstName: 'A', lastName: 'B' })
    .returning();
  return (cachedAdmin = row!.id);
}
const beneficiary = (user: Parameters<typeof createBeneficiary>[1], accountNumber: string) =>
  createBeneficiary(h.ctx, user, { name: 'Mum', category: 'family', bankCode: '044', accountNumber }, {});

describe('flutterwave adapter', () => {
  it('gives everyone the shared test number and still keeps their accounts apart', async () => {
    const [ada, obi] = [await verifiedUser(h), await verifiedUser(h)];
    expect([ada.accountNumber, obi.accountNumber]).toEqual(['0067100155', '0067100155']);
    const event = fake.payIntoAccount(`psa-${obi.id}`, 4000);
    const body = Buffer.from(
      JSON.stringify({ event: 'charge.completed', data: { id: event.id, tx_ref: event.tx_ref } }),
    );
    await receivePaymentWebhook(h.ctx, body, { 'verif-hash': HASH });
    await receivePaymentWebhook(h.ctx, body, { 'verif-hash': HASH });
    await h.drain();
    const paid = await h.ctx.db.select().from(salaryPayments).where(eq(salaryPayments.userId, obi.id));
    expect(paid.map((p) => [p.amount, p.providerFee, p.senderName, p.source])).toEqual([
      [400_000n, 7_000n, 'JOHN DOE', 'bank_transfer'],
    ]);
    expect(await h.ctx.db.$count(salaryPayments, eq(salaryPayments.userId, ada.id))).toBe(0);
  });

  it('credits each payment into one account once, though they share a reference', async () => {
    const user = await verifiedUser(h);
    fake.payIntoAccount(`psa-${user.id}`, 1000);
    fake.payIntoAccount(`psa-${user.id}`, 1000);
    fake.payIntoAccount('another-app-order-1', 9000);
    await recoverPayIns(h.ctx);
    await recoverPayIns(h.ctx);
    expect(await h.ctx.db.$count(salaryPayments, eq(salaryPayments.userId, user.id))).toBe(2);
  });

  it('refuses webhooks without the secret hash and ignores other software', async () => {
    const body = Buffer.from(
      JSON.stringify({ event: 'charge.completed', data: { id: 1, tx_ref: 'order-1' } }),
    );
    expect(() => flw.parseWebhook(body, { 'verif-hash': 'wrong' })).toThrow(/signature/);
    expect(() => flw.parseWebhook(body, {})).toThrow(/signature/);
    expect(flw.parseWebhook(body, { 'verif-hash': HASH }).kind).toBe('ignored');
    const transfer = Buffer.from(
      JSON.stringify({ event: 'transfer.completed', data: { id: 2, reference: 'psp-x-1_PMCKDU_1' } }),
    );
    expect(flw.parseWebhook(transfer, { 'verif-hash': HASH })).toMatchObject({ reference: 'psp-x-1' });
  });

  it('names an account through a beneficiary while the lookup is down, and reuses one already saved', async () => {
    expect(await flw.resolveAccount('044', '0690000031')).toEqual({ accountName: 'Pastor Bright' });
    const first = await flw.createRecipient({
      name: 'X',
      bankCode: '044',
      accountNumber: '0690000031',
    });
    const again = await flw.createRecipient({
      name: 'Y',
      bankCode: '044',
      accountNumber: '0690000031',
    });
    expect(again).toEqual(first);
    const onLaterPage = await flw.createRecipient({
      name: 'Z',
      bankCode: '044',
      accountNumber: '0690000021',
    });
    expect(onLaterPage.recipientCode).toBe('12');
  });

  it('splits a salary end to end and the books agree', async () => {
    const user = await verifiedUser(h);
    const wallet = await addWallet(h, user, 'Savings');
    const mum = await beneficiary(user, '0690000032');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'percentage', 2000, 1);
    await addRule(h, user, { type: 'beneficiary', id: mum.id }, 'fixed', 250_055, 2);
    await pay(user.id, 1_000_000n);
    await confirmPayIns(h.ctx);
    await h.drain();
    fake.settleTransfers();
    h.clock.advance(3 * 60_000);
    await h.drain();
    const rows = await h.ctx.db.select().from(transfers).where(eq(transfers.userId, user.id));
    expect(rows.map((r) => [r.status, r.amount])).toEqual([['success', 250_055n]]);
    expect(fake.transfers.at(-1)).toMatchObject({ amount: 2500.55 });
    const critical = (await checkBooks(h.ctx)).filter((c) => c.severity === 'critical' && c.detail);
    expect(critical).toEqual([]);
  });

  it('never pays twice when an accepted transfer loses its answer', async () => {
    const user = await verifiedUser(h);
    const mum = await beneficiary(user, '0690000033');
    await addRule(h, user, { type: 'beneficiary', id: mum.id }, 'fixed', 100_000, 1);
    const before = fake.transfers.length;
    await pay(user.id, 500_000n);
    fake.loseNextTransferAnswer = true;
    await confirmPayIns(h.ctx);
    await h.drain();
    const status = async () =>
      (await h.ctx.db.select().from(transfers).where(eq(transfers.userId, user.id)))[0]!.status;
    expect(await status()).toBe('unknown');
    h.clock.advance(60_000);
    await h.drain();
    fake.settleTransfers();
    h.clock.advance(3 * 60_000);
    await h.drain();
    expect([await status(), fake.transfers.length - before]).toEqual(['success', 1]);
  });

  it('treats a refused repeat of a reference as already sent, not as a failure', async () => {
    const input = { reference: `psp-${crypto.randomUUID()}-1`, amount: 10_000n, narration: 'x' };
    const { recipientCode } = await flw.createRecipient({
      name: 'X',
      bankCode: '058',
      accountNumber: '0123456789',
    });
    await flw.initiateTransfer({ ...input, recipientCode });
    await expect(flw.initiateTransfer({ ...input, recipientCode })).rejects.toMatchObject({
      kind: 'unknown',
    });
    expect((await flw.getTransfer(input.reference)).reference).toBe(input.reference);
    await expect(flw.getTransfer('psp-never-sent-1')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('retries a transfer the provider fails with new references, then returns the money', async () => {
    const user = await verifiedUser(h);
    const bad = await beneficiary(user, '0690000040');
    await addRule(h, user, { type: 'beneficiary', id: bad.id }, 'fixed', 100_000, 1);
    await pay(user.id, 300_000n);
    await confirmPayIns(h.ctx);
    for (let i = 0; i < 8; i++) {
      await h.drain();
      fake.settleTransfers();
      h.clock.advance(6 * 60_000);
    }
    await h.drain();
    const [row] = await h.ctx.db.select().from(transfers).where(eq(transfers.userId, user.id));
    const attempts = await h.ctx.db
      .select()
      .from(transferAttempts)
      .where(eq(transferAttempts.transferId, row!.id));
    expect([row!.status, attempts.length, new Set(attempts.map((a) => a.reference)).size]).toEqual([
      'failed',
      3,
      3,
    ]);
    const critical = (await checkBooks(h.ctx)).filter((c) => c.severity === 'critical' && c.detail);
    expect(critical).toEqual([]);
  });

  it('will not make accounts or test pay-ins with a live key', async () => {
    const live = new FlutterwaveProvider({
      secretKey: 'FLWSECK-live-X',
      webhookHash: HASH,
      baseUrl: fake.url,
      timeoutMs: 3000,
    });
    await expect(
      live.submitTestPayIn({ reference: 'psi-x', amount: 1n, email: 'a@example.com', metadata: {} }),
    ).rejects.toMatchObject({ code: 'test_mode_only' });
  });

  it('keeps two accounts from claiming one provider reference', async () => {
    const [one] = await h.ctx.db.select().from(salaryAccounts).limit(1);
    const user = await verifiedUser(h);
    await expect(
      h.ctx.db
        .update(salaryAccounts)
        .set({ providerCustomerCode: one!.providerCustomerCode })
        .where(eq(salaryAccounts.userId, user.id)),
    ).rejects.toThrow();
  });
});
