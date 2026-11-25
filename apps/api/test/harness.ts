import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DEFAULT_PREFS } from '@paysplit/core';
import { startEmulators, type Emulators } from '@paysplit/emulators';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { createContext } from '../src/create-context.ts';
import { jobs, kycCases, users } from '../src/db/schema.ts';
import { runDueJobs } from '../src/modules/jobs.ts';
import { forgetPlatformAccounts } from '../src/modules/ledger.ts';
import { provisionSalaryAccount, prepareSalaryAccount } from '../src/modules/salary-accounts.ts';
import { jobHandlers } from '../src/modules/scheduler.ts';
import type { UserRow } from '../src/modules/sessions.ts';
import { createWallet } from '../src/modules/wallets.ts';
import { createBeneficiary } from '../src/modules/beneficiaries.ts';
import { createRule, setRuleStatus } from '../src/modules/rules.ts';
import { receivePaymentWebhook } from '../src/modules/webhooks.ts';
import type { OutgoingEmail } from '../src/ports/email.ts';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5544/postgres';
const TEST_DB = 'paysplit_test';
export const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoicGF5c3BsaXQtbG9jYWwiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0._nd0fYdabp5aayq9cbkOzrme0LXQwB9MTdXymxpKVBk';

export interface Harness {
  ctx: Ctx;
  emulators: Emulators;
  outbox: OutgoingEmail[];
  clock: { now: Date; advance(ms: number): void };
  app: Awaited<ReturnType<typeof buildApp>>;
  drain(): Promise<void>;
  webhook(event: string, reference: string): Promise<void>;
  close(): Promise<void>;
}

/** Real Postgres, the real GoTrue container, the real adapters, and emulated provider HTTP endpoints. */
export async function createHarness(): Promise<Harness> {
  const adminDb = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await adminDb.unsafe(`drop database if exists ${TEST_DB} with (force)`);
  await adminDb.unsafe(`create database ${TEST_DB}`);
  await adminDb.end();
  forgetPlatformAccounts();

  const emulators = await startEmulators({ autoWebhooks: false });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_URL: 'http://localhost:5173',
    DATABASE_URL: ADMIN_URL.replace(/\/postgres$/, `/${TEST_DB}`),
    SUPABASE_AUTH_URL: process.env.TEST_AUTH_URL ?? 'http://localhost:9999',
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FINGERPRINT_KEY: 'test-fingerprint-key-that-is-32-chars-long',
    CRON_SECRET: 'test-cron-secret-1234',
    PAYSTACK_SECRET_KEY: 'sk_test_emulator',
    PAYSTACK_BASE_URL: `${emulators.url}/paystack`,
    PAYSTACK_TIMEOUT_MS: '3000',
    DOJAH_APP_ID: 'emulator',
    DOJAH_SECRET_KEY: 'emulator',
    DOJAH_BASE_URL: `${emulators.url}/dojah`,
    RATE_LIMITS: 'false',
  });
  const { ctx, close } = createContext(config);
  await migrate(ctx.db, { migrationsFolder: './drizzle', migrationsSchema: 'paysplit_migrations' });

  const outbox: OutgoingEmail[] = [];
  ctx.mailer = { send: async (email) => void outbox.push(email) };
  const clock = {
    now: new Date(),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  ctx.now = () => clock.now;
  const app = await buildApp(ctx);

  return {
    ctx,
    emulators,
    outbox,
    clock,
    app,
    /** Runs every job that is due now, including ones those jobs queue. Waiting retries stay waiting. */
    async drain() {
      for (let round = 0; round < 50; round++) {
        clock.advance(1);
        // Jobs queued by the database default to its own clock, so anything not scheduled ahead is due.
        await ctx.db
          .update(jobs)
          .set({ runAt: clock.now })
          .where(sql`status = 'queued' and run_at <= now() + interval '1 second'`);
        if ((await runDueJobs(ctx, jobHandlers)) === 0) return;
      }
      throw new Error('Jobs kept queueing more jobs');
    },
    async webhook(event, reference) {
      const body = emulators.webhookBody(event, reference);
      await receivePaymentWebhook(ctx, Buffer.from(body), { 'x-paystack-signature': emulators.sign(body) });
    },
    async close() {
      await app.close();
      await close();
      await emulators.close();
    },
  };
}

let counter = 0;

/** A verified person with a live salary account, skipping the sign-up screens. */
export async function verifiedUser(
  h: Harness,
  overrides: Partial<UserRow> = {},
): Promise<UserRow & { accountNumber: string }> {
  const n = ++counter;
  const [user] = await h.ctx.db
    .insert(users)
    .values({
      authId: crypto.randomUUID(),
      email: `user${n}-${Date.now()}@example.com`,
      firstName: 'Ada',
      lastName: `Test${n}`,
      emailVerifiedAt: h.clock.now,
      country: 'NG',
      phone: '+2348031234567',
      kycStatus: 'approved',
      notificationPrefs: DEFAULT_PREFS,
      ...overrides,
    })
    .returning();
  if (user!.kycStatus === 'approved') {
    await h.ctx.db.insert(kycCases).values({
      userId: user!.id,
      country: 'NG',
      provider: 'dojah',
      status: 'approved',
      identityType: 'bvn',
      identityLast4: '2222',
      identityFingerprint: `fp-${n}`,
      identityStatus: 'passed',
      livenessStatus: 'passed',
    });
    await h.ctx.db.transaction((tx) => prepareSalaryAccount(tx, user!.id, h.ctx.payments.name));
    await provisionSalaryAccount(h.ctx, user!.id);
  }
  const account = await h.ctx.db.query.salaryAccounts.findFirst({ where: (t) => eq(t.userId, user!.id) });
  return { ...user!, accountNumber: account?.accountNumber ?? '' };
}

export async function addWallet(h: Harness, user: UserRow, name: string) {
  return createWallet(h.ctx, user, { name, category: 'savings', accent: 'blue' }, {});
}

/** Account numbers ending 00 fail at the emulator, 99 stay pending, anything else succeeds. */
export async function addBeneficiary(h: Harness, user: UserRow, accountNumber: string, name = 'Mum') {
  return createBeneficiary(h.ctx, user, { name, category: 'family', bankCode: '058', accountNumber }, {});
}

export async function addRule(
  h: Harness,
  user: UserRow,
  destination: { type: 'wallet' | 'beneficiary'; id: string },
  method: 'fixed' | 'percentage',
  value: number,
  priority: number,
) {
  const rule = await createRule(
    h.ctx,
    user,
    {
      name: `${method} ${value}`,
      destinationType: destination.type,
      destinationId: destination.id,
      method,
      value,
      priority,
    },
    {},
  );
  await setRuleStatus(h.ctx, user, rule.id, 'activate', {});
  return rule;
}

export async function balances(h: Harness, userId: string) {
  const rows = await h.ctx.db.execute<{ code: string; type: string; balance: string }>(
    sql`select code, type, balance from paysplit.account_balances where user_id = ${userId}`,
  );
  return {
    salary: Number(rows.find((r) => r.type === 'user_salary')?.balance ?? 0),
    wallets: rows.filter((r) => r.type === 'wallet').reduce((sum, r) => sum + Number(r.balance), 0),
  };
}

export async function platform(h: Harness, code: string): Promise<number> {
  const [row] = await h.ctx.db.execute<{ balance: string }>(
    sql`select balance from paysplit.account_balances where code = ${`platform:${code}`}`,
  );
  return Number(row!.balance);
}
