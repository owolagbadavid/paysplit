import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import type { Tx } from '../db/client.ts';
import { salaryAccounts, users } from '../db/schema.ts';
import { conflict, notFound, ProviderError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { requireVerified } from './eligibility.ts';
import { enqueue } from './jobs.ts';
import { openAccount } from './ledger.ts';
import { notify } from './notifications.ts';
import type { UserRow } from './sessions.ts';

/** Reserves the record and ledger account for a newly verified person, before any provider call. */
export async function prepareSalaryAccount(tx: Tx, userId: string, provider: string): Promise<void> {
  const [existing] = await tx
    .select({ id: salaryAccounts.id })
    .from(salaryAccounts)
    .where(eq(salaryAccounts.userId, userId));
  if (existing) return;
  const ledgerAccountId = await openAccount(tx, { code: `salary:${userId}`, type: 'user_salary', userId });
  await tx.insert(salaryAccounts).values({ userId, ledgerAccountId, provider });
}

/**
 * Asks the provider for the dedicated collection account. Safe to repeat: the provider keys it by customer, so a
 * retry after a lost answer finds the account that was already made. Outages throw, so the job retries.
 */
export async function provisionSalaryAccount(ctx: Ctx, userId: string): Promise<void> {
  const [account] = await ctx.db.select().from(salaryAccounts).where(eq(salaryAccounts.userId, userId));
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!account || !user || account.status === 'active' || user.kycStatus !== 'approved') return;

  try {
    const created = await ctx.payments.provisionCollectionAccount({
      reference: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone ?? '',
    });
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(salaryAccounts)
        .set({
          status: 'active',
          providerCustomerCode: created.customerCode,
          providerAccountId: created.accountId,
          accountNumber: created.accountNumber,
          accountName: created.accountName,
          bankName: created.bankName,
          failureReason: null,
          activatedAt: ctx.now(),
        })
        .where(eq(salaryAccounts.id, account.id));
      await audit(tx, {
        actor: { type: 'system' },
        userId,
        action: 'salary_account.activated',
        target: { type: 'salary_account', id: account.id },
      });
      await notify(tx, {
        userId,
        type: 'salary_account_ready',
        dedupeKey: `salary-account:${account.id}`,
        severity: 'success',
        title: 'Your salary account is ready',
        body: 'Share the account details with your employer to start receiving your salary in PaySplit.',
        link: '/dashboard',
        email: {
          content: {
            subject: 'Your PaySplit salary account is ready',
            paragraphs: [
              'Your dedicated salary account is ready. Open PaySplit to copy the details and share them with your employer or payroll team.',
            ],
            button: { label: 'View account details', url: `${ctx.config.APP_URL}/dashboard` },
          },
        },
      });
    });
  } catch (error) {
    if (!(error instanceof ProviderError) || error.kind === 'unknown' || error.kind === 'throttled')
      throw error;
    await ctx.db
      .update(salaryAccounts)
      .set({ status: 'failed', failureReason: error.message.slice(0, 300) })
      .where(eq(salaryAccounts.id, account.id));
    ctx.log.error({ err: error, userId }, 'salary account refused');
  }
}

export async function retryProvisioning(ctx: Ctx, user: UserRow): Promise<void> {
  requireVerified(user);
  await ctx.db.transaction(async (tx) => {
    await prepareSalaryAccount(tx, user.id, ctx.payments.name);
    const [account] = await tx
      .select()
      .from(salaryAccounts)
      .where(eq(salaryAccounts.userId, user.id))
      .for('update');
    if (!account) throw notFound('Salary account');
    if (account.status === 'active')
      throw conflict('already_active', 'Your salary account is already active');
    await tx
      .update(salaryAccounts)
      .set({ status: 'provisioning', failureReason: null })
      .where(eq(salaryAccounts.id, account.id));
    await enqueue(tx, 'salary_account.provision', { userId: user.id }, { dedupeKey: `provision:${user.id}` });
  });
}

/**
 * Locks a person's salary account for the rest of the transaction. Every operation that moves their money takes
 * this first, so their balances are only ever read and changed by one operation at a time.
 */
export async function lockSalaryAccount(tx: Tx, userId: string) {
  const [account] = await tx
    .select()
    .from(salaryAccounts)
    .where(eq(salaryAccounts.userId, userId))
    .for('update');
  return account ?? null;
}
