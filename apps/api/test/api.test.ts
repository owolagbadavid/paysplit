import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admins,
  auditLogs,
  emails,
  kycCases,
  payinRuns,
  salaryPayments,
  users,
  webhookEvents,
} from '../src/db/schema.ts';
import { DEFAULT_PREFS } from '@paysplit/core';
import { DojahProvider } from '../src/adapters/dojah.ts';
import { eraseStaleIdentityNumbers } from '../src/modules/kyc.ts';
import { provisionSalaryAccount } from '../src/modules/salary-accounts.ts';
import { tick } from '../src/modules/scheduler.ts';
import { RegionRouter } from '../src/ports/verification.ts';
import { addRule, addWallet, createHarness, verifiedUser, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A browser: keeps cookies and sends the headers the web app sends. */
class Client {
  cookies = new Map<string, string>();
  async call(method: Method, url: string, payload?: object, headers: Record<string, string> = {}) {
    const response = await h.app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: {
        'x-paysplit-client': 'web',
        'user-agent': 'vitest',
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
    });
    for (const c of response.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      if (c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return {
      status: response.statusCode,
      body: response.headers['content-type']?.includes('json') ? response.json() : response.body,
      raw: response,
    };
  }
}

const PASSWORD = 'Correct-Horse-9';
const newEmail = () => `person-${crypto.randomUUID().slice(0, 12)}@example.com`;
const selfie = (marker = 'FACE') => Buffer.from(marker.padEnd(1200, 'x')).toString('base64');

async function lastEmail(to: string, template: string) {
  const [row] = await h.ctx.db
    .select()
    .from(emails)
    .where(eq(emails.recipient, to))
    .orderBy(desc(emails.createdAt));
  expect(row?.template).toBe(template);
  return row!;
}
const codeIn = (text: string) => /^(\d{6})$/m.exec(text)![1]!;
const tokenIn = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);

async function signUp(client: Client, email = newEmail(), password = PASSWORD) {
  const response = await client.call('POST', '/v1/auth/register', {
    firstName: 'Ada',
    lastName: 'Obi',
    email,
    password,
    confirmPassword: password,
  });
  expect(response.status).toBe(202);
  return email;
}
async function signedInUser() {
  const client = new Client();
  const email = await signUp(client);
  const verified = await client.call('POST', '/v1/auth/verify-email', {
    email,
    code: codeIn((await lastEmail(email, 'verify_email')).text),
  });
  expect(verified.body).toEqual({ next: 'signed_in' });
  return { client, email };
}
async function onboarded() {
  const { client, email } = await signedInUser();
  await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
  await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
  expect((await client.call('POST', '/v1/kyc/liveness', { image: selfie() })).body.status).toBe('approved');
  await h.drain();
  return { client, email, id: (await client.call('GET', '/v1/me')).body.id as string };
}

async function adminClient() {
  const email = newEmail();
  const { authId } = await h.ctx.auth.createVerifiedUser({ email, password: PASSWORD });
  await h.ctx.db.insert(admins).values({ authId, email, firstName: 'Marcus', lastName: 'Vance' });
  const client = new Client();
  expect((await client.call('POST', '/v1/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return { client, email };
}

describe('registration and sign-in', () => {
  it('requires a verified email before anything else works', async () => {
    const client = new Client();
    const email = await signUp(client);
    expect((await client.call('GET', '/v1/me')).status).toBe(401);
    expect((await client.call('POST', '/v1/auth/login', { email, password: PASSWORD })).body.error.code).toBe(
      'email_unverified',
    );
    expect(
      (await client.call('POST', '/v1/auth/verify-email', { email, code: '000000' })).body.error.code,
    ).toBe('invalid_code');
    const ok = await client.call('POST', '/v1/auth/verify-email', {
      token: tokenIn((await lastEmail(email, 'verify_email')).text),
    });
    expect(ok.body).toEqual({ next: 'signed_in' });
    expect((await client.call('GET', '/v1/me')).body).toMatchObject({
      email,
      kycStatus: 'not_started',
      tier: 1,
    });
  });

  it('keeps the newest chosen password through re-registering, a resent code and verifying', async () => {
    const client = new Client();
    const email = await signUp(client, newEmail(), 'First-Choice-Pass-1');
    await signUp(client, email, PASSWORD);
    expect((await client.call('POST', '/v1/auth/resend-verification', { email })).status).toBe(202);
    const code = codeIn((await lastEmail(email, 'verify_email')).text);
    expect((await client.call('POST', '/v1/auth/verify-email', { email, code })).body.next).toBe('signed_in');
    const signIn = (password: string) => new Client().call('POST', '/v1/auth/login', { email, password });
    expect((await signIn(PASSWORD)).status).toBe(200);
    expect((await signIn('First-Choice-Pass-1')).status).toBe(401);
  });

  it('does not let someone who registered another person’s email keep their password after the owner verifies', async () => {
    const attacker = new Client();
    const email = await signUp(attacker, newEmail(), 'Attackers-Pass-1');
    const owner = new Client();
    const result = await owner.call('POST', '/v1/auth/verify-email', {
      token: tokenIn((await lastEmail(email, 'verify_email')).text),
    });
    expect(result.body.next).toBe('set_password');
    expect(
      (await attacker.call('POST', '/v1/auth/login', { email, password: 'Attackers-Pass-1' })).status,
    ).toBe(401);
    expect(
      (await owner.call('POST', '/v1/auth/reset-password', { token: result.body.token, password: PASSWORD }))
        .status,
    ).toBe(200);
    expect((await owner.call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('answers the same whether or not an email is taken', async () => {
    const { email } = await signedInUser();
    const taken = await new Client().call('POST', '/v1/auth/register', {
      firstName: 'X',
      lastName: 'Y',
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    expect([taken.status, taken.body]).toEqual([202, { email }]);
    await lastEmail(email, 'register_existing');
    const forgot = await new Client().call('POST', '/v1/auth/forgot-password', { email: newEmail() });
    expect(forgot.status).toBe(202);
    const wrongPassword = await new Client().call('POST', '/v1/auth/login', { email, password: 'nope' });
    const wrongEmail = await new Client().call('POST', '/v1/auth/login', {
      email: newEmail(),
      password: 'nope',
    });
    expect(wrongPassword.body.error).toEqual(wrongEmail.body.error);
  });

  it('enforces the password rules and confirmation', async () => {
    const bad = await new Client().call('POST', '/v1/auth/register', {
      firstName: 'A',
      lastName: 'B',
      email: newEmail(),
      password: 'short',
      confirmPassword: 'other',
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toContain('password');
  });

  it('locks an account after repeated wrong passwords', async () => {
    const { email } = await signedInUser();
    const client = new Client();
    for (let i = 0; i < 8; i++) await client.call('POST', '/v1/auth/login', { email, password: 'wrong' });
    expect((await client.call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(429);
  });

  it('signs other devices out when the password changes, and reset links work once', async () => {
    const { client, email } = await signedInUser();
    const other = new Client();
    await other.call('POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(
      (
        await client.call('POST', '/v1/me/change-password', {
          currentPassword: 'wrong',
          newPassword: 'Another-Pass-22',
        })
      ).body.error.code,
    ).toBe('wrong_password');
    expect(
      (
        await client.call('POST', '/v1/me/change-password', {
          currentPassword: PASSWORD,
          newPassword: 'Another-Pass-22',
        })
      ).status,
    ).toBe(200);
    expect((await other.call('GET', '/v1/me')).status).toBe(401);
    expect((await client.call('GET', '/v1/me')).status).toBe(200);

    await new Client().call('POST', '/v1/auth/forgot-password', { email });
    const token = tokenIn((await lastEmail(email, 'reset_password')).text);
    expect(
      (await new Client().call('POST', '/v1/auth/reset-password', { token, password: 'Third-Password-3' }))
        .status,
    ).toBe(200);
    expect(
      (await new Client().call('POST', '/v1/auth/reset-password', { token, password: 'Fourth-Password-4' }))
        .status,
    ).toBe(400);
    expect((await client.call('GET', '/v1/me')).status).toBe(401);
  });

  it('rejects state changes that could come from another site', async () => {
    const { client } = await signedInUser();
    const noHeader = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `ps_session=${client.cookies.get('ps_session')}` },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(
      (await client.call('POST', '/v1/auth/logout', undefined, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await client.call('GET', '/v1/me')).status).toBe(200);
  });

  it('sets hardened cookies and blanks emails that carried a code once sent', async () => {
    const client = new Client();
    const email = await signUp(client);
    const code = codeIn((await lastEmail(email, 'verify_email')).text);
    const response = await client.call('POST', '/v1/auth/verify-email', { email, code });
    const cookie = String(response.raw.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    await h.drain();
    const sent = await h.ctx.db.select().from(emails).where(eq(emails.recipient, email));
    expect(sent.filter((e) => e.sensitive).every((e) => e.text === '' && e.html === '')).toBe(true);
  });
});

describe('verification', () => {
  it('walks profile, identity and liveness, erases the number, and provisions the salary account', async () => {
    const { client } = await signedInUser();
    expect((await client.call('GET', '/v1/kyc')).body.step).toBe('profile');
    expect((await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '123' })).status).toBe(400);
    await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
    expect((await client.call('POST', '/v1/kyc/liveness', { image: selfie() })).body.error.code).toBe(
      'identity_first',
    );
    expect(
      (await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '11111111111' })).body.error.code,
    ).toBe('identity_not_verified');
    expect((await client.call('GET', '/v1/kyc')).body).toMatchObject({
      status: 'action_required',
      step: 'identity',
    });
    expect(
      (await client.call('POST', '/v1/kyc/identity', { type: 'nin', number: '70123456789' })).body,
    ).toMatchObject({ status: 'in_progress', step: 'liveness' });

    const id = (await client.call('GET', '/v1/me')).body.id;
    const [open] = await h.ctx.db
      .select()
      .from(kycCases)
      .where(eq(kycCases.userId, id))
      .orderBy(desc(kycCases.createdAt));
    expect(open!.identityNumberEnc).not.toContain('70123456789');
    expect((await client.call('POST', '/v1/kyc/liveness', { image: selfie('NOFACE') })).body.error.code).toBe(
      'liveness_failed',
    );
    expect(
      (await client.call('POST', '/v1/kyc/liveness', { image: selfie('OTHER') })).body.error.message,
    ).toMatch(/did not match/);
    expect((await client.call('POST', '/v1/kyc/liveness', { image: selfie() })).body).toMatchObject({
      status: 'approved',
      step: 'done',
    });
    const [done] = await h.ctx.db.select().from(kycCases).where(eq(kycCases.id, open!.id));
    expect(done!.identityNumberEnc).toBeNull();
    await h.drain();
    expect((await client.call('GET', '/v1/salary-account')).body.account).toMatchObject({
      status: 'active',
      bankName: 'Test Bank',
    });
  });

  it('rejects after three failed liveness attempts and lets the person start again', async () => {
    const { client } = await signedInUser();
    await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
    await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
    for (let i = 0; i < 3; i++) await client.call('POST', '/v1/kyc/liveness', { image: selfie('SPOOF') });
    expect((await client.call('GET', '/v1/kyc')).body).toMatchObject({
      status: 'rejected',
      step: 'identity',
    });
    expect(
      (await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' })).body.step,
    ).toBe('liveness');
  });

  it('reads the answer the hosted sandbox sends, and does not approve on it', async () => {
    const { client } = await signedInUser();
    await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
    await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
    const answer = await client.call('POST', '/v1/kyc/liveness', { image: selfie('HOSTED') });
    expect([answer.status, answer.body.error.code]).toEqual([422, 'liveness_failed']);
    expect(answer.body.error.message).toMatch(/live person/);
  });

  describe('when the provider’s liveness answer is the same for every photo', () => {
    const inReview = async () => {
      const usual = h.ctx.verification;
      h.ctx.verification = new RegionRouter({
        NG: new DojahProvider({
          appId: 'emulator',
          secretKey: 'emulator',
          baseUrl: h.ctx.config.DOJAH_BASE_URL,
          matchThreshold: 70,
          livenessThreshold: 50,
          fixedLiveness: true,
        }),
      });
      const { client, email } = await signedInUser();
      await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
      await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
      const answer = await client.call('POST', '/v1/kyc/liveness', { image: selfie('HOSTED') });
      h.ctx.verification = usual;
      return { client, email, answer, id: (await client.call('GET', '/v1/me')).body.id as string };
    };
    const review = async (id: string, decision: 'approve' | 'reject', client: Client) =>
      client.call('POST', `/v1/admin/users/${id}/kyc-review`, { decision, note: 'Checked by hand' });

    it('sends the case to review, unlocks nothing, and erases the number', async () => {
      const { client, answer, id } = await inReview();
      expect(answer.body).toMatchObject({ status: 'pending_review', step: 'review' });
      expect(
        (await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' })).body.error
          .code,
      ).toBe('in_review');
      const [row] = await h.ctx.db.select().from(kycCases).where(eq(kycCases.userId, id));
      expect(row).toMatchObject({ livenessStatus: 'in_review', identityNumberEnc: null, livenessScore: 0 });
      await h.drain();
      expect((await client.call('GET', '/v1/salary-account')).body.account).toBeNull();
    });

    it('opens the salary account once an administrator approves, and records who and why', async () => {
      const { client, id } = await inReview();
      const { client: admin } = await adminClient();
      expect((await review(id, 'approve', client)).status).toBe(401);
      expect((await admin.call('GET', '/v1/admin/users?verification=review')).body.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id })]),
      );
      expect(
        (await admin.call('POST', `/v1/admin/users/${id}/kyc-review`, { decision: 'approve', note: '' }))
          .status,
      ).toBe(400);
      expect((await review(id, 'approve', admin)).status).toBe(200);
      expect((await review(id, 'reject', admin)).body.error.code).toBe('not_in_review');
      await h.drain();
      expect((await client.call('GET', '/v1/kyc')).body).toMatchObject({ status: 'approved', step: 'done' });
      expect((await client.call('GET', '/v1/salary-account')).body.account.status).toBe('active');
      const [log] = await h.ctx.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.userId, id), eq(auditLogs.action, 'admin.kyc_approved')));
      expect(log!.metadata).toMatchObject({ note: 'Checked by hand' });
    });

    it('lets a rejected person start again', async () => {
      const { client, id } = await inReview();
      expect((await review(id, 'reject', (await adminClient()).client)).status).toBe(200);
      expect((await client.call('GET', '/v1/kyc')).body).toMatchObject({
        status: 'rejected',
        step: 'identity',
      });
      expect((await client.call('GET', '/v1/salary-account')).body.account).toBeNull();
    });
  });

  it('decides nothing while the provider is down', async () => {
    const { client } = await signedInUser();
    await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
    h.emulators.state.dojahDown = true;
    const response = await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
    h.emulators.state.dojahDown = false;
    expect([response.status, response.body.error.code]).toEqual([503, 'provider_unavailable']);
    expect((await client.call('GET', '/v1/kyc')).body.status).toBe('not_started');
  });

  it('does not offer verification where PaySplit has not launched', async () => {
    const { client } = await signedInUser();
    await client.call('PUT', '/v1/me/profile', { country: 'GB', phone: '+447400123456' });
    expect((await client.call('GET', '/v1/kyc')).body.step).toBe('unsupported');
    expect(
      (await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' })).body.error.code,
    ).toBe('country_not_supported');
  });

  it('erases identity numbers from attempts nobody finished', async () => {
    const { client } = await signedInUser();
    await client.call('PUT', '/v1/me/profile', { country: 'NG', phone: '08031234567' });
    await client.call('POST', '/v1/kyc/identity', { type: 'bvn', number: '22222222222' });
    const before = h.clock.now;
    h.clock.advance(25 * 3_600_000);
    await eraseStaleIdentityNumbers(h.ctx);
    h.clock.now = before;
    expect((await client.call('GET', '/v1/kyc')).body.step).toBe('identity');
  });

  it('recovers a salary account whose first answer was lost', async () => {
    const { id } = await onboarded();
    await provisionSalaryAccount(h.ctx, id);
    const user = await verifiedUser(h);
    expect(user.accountNumber).toMatch(/^\d{10}$/);
  });
});

describe('what unverified people cannot do', () => {
  it('lets them configure but refuses every financial action at the API', async () => {
    const { client } = await signedInUser();
    const wallet = (await client.call('POST', '/v1/wallets', { name: 'Savings', category: 'savings' })).body;
    expect(wallet.balance).toBe(0);
    const rule = (
      await client.call('POST', '/v1/rules', {
        name: 'Save',
        destinationType: 'wallet',
        destinationId: wallet.id,
        method: 'percentage',
        value: 1000,
        priority: 1,
      })
    ).body;
    expect(rule.status).toBe('draft');
    const key = { 'idempotency-key': crypto.randomUUID() };
    const refused = await Promise.all([
      client.call('POST', `/v1/rules/${rule.id}/activate`),
      client.call('POST', `/v1/wallets/${wallet.id}/move`, { amount: 100 }, key),
      client.call(
        'POST',
        '/v1/splits/run-now',
        { salaryPaymentId: crypto.randomUUID(), planHash: 'a'.repeat(64) },
        key,
      ),
      client.call('POST', '/v1/salary-account/provision'),
    ]);
    expect(refused.map((r) => [r.status, r.body.error.code])).toEqual(Array(4).fill([403, 'kyc_required']));
  });
});

describe('ownership', () => {
  it('hides other people’s records', async () => {
    const a = await onboarded();
    const b = await onboarded();
    const wallet = (await a.client.call('POST', '/v1/wallets', { name: 'Mine', category: 'savings' })).body;
    const ben = (
      await a.client.call('POST', '/v1/beneficiaries', {
        name: 'Mum',
        category: 'family',
        bankCode: '058',
        accountNumber: '0123456741',
      })
    ).body;
    const rule = (
      await a.client.call('POST', '/v1/rules', {
        name: 'R',
        destinationType: 'wallet',
        destinationId: wallet.id,
        method: 'fixed',
        value: 1000,
        priority: 1,
      })
    ).body;
    const tries = await Promise.all([
      b.client.call('GET', `/v1/wallets/${wallet.id}`),
      b.client.call('PATCH', `/v1/wallets/${wallet.id}`, { name: 'Theirs', category: 'savings' }),
      b.client.call('GET', `/v1/beneficiaries/${ben.id}?reveal=true`),
      b.client.call('DELETE', `/v1/beneficiaries/${ben.id}`),
      b.client.call('GET', `/v1/rules/${rule.id}`),
      b.client.call('POST', `/v1/rules/${rule.id}/activate`),
      b.client.call('POST', '/v1/rules', {
        name: 'X',
        destinationType: 'wallet',
        destinationId: wallet.id,
        method: 'fixed',
        value: 1,
        priority: 1,
      }),
      b.client.call(
        'POST',
        `/v1/wallets/${wallet.id}/move`,
        { amount: 1 },
        { 'idempotency-key': crypto.randomUUID() },
      ),
    ]);
    expect(tries.map((t) => t.status)).toEqual(Array(8).fill(404));
  });

  it('masks account numbers unless the owner asks, and records when they do', async () => {
    const { client, id } = await onboarded();
    const ben = (
      await client.call('POST', '/v1/beneficiaries', {
        name: 'Mum',
        category: 'family',
        bankCode: '058',
        accountNumber: '0123456742',
      })
    ).body;
    expect(JSON.stringify(ben)).not.toContain('0123456742');
    expect((await client.call('GET', `/v1/beneficiaries/${ben.id}`)).body.accountNumber).toBeNull();
    expect((await client.call('GET', `/v1/beneficiaries/${ben.id}?reveal=true`)).body.accountNumber).toBe(
      '0123456742',
    );
    const log = await h.ctx.db.select().from(auditLogs).where(eq(auditLogs.userId, id));
    expect(log.map((l) => l.action)).toContain('beneficiary.account_revealed');
  });
});

describe('rules and beneficiaries', () => {
  it('allows one rule per destination and points at the existing one', async () => {
    const { client } = await onboarded();
    const wallet = (await client.call('POST', '/v1/wallets', { name: 'Savings', category: 'savings' })).body;
    const body = {
      name: 'R',
      destinationType: 'wallet',
      destinationId: wallet.id,
      method: 'fixed',
      value: 1000,
      priority: 1,
    };
    const first = (await client.call('POST', '/v1/rules', body)).body;
    const second = await client.call('POST', '/v1/rules', body);
    expect([second.status, second.body.error.code, second.body.error.details.ruleId]).toEqual([
      409,
      'rule_exists',
      first.id,
    ]);
    await client.call('DELETE', `/v1/rules/${first.id}`);
    expect((await client.call('POST', '/v1/rules', body)).status).toBe(201);
  });

  it('refuses active percentages above 100%', async () => {
    const { client } = await onboarded();
    const make = async (name: string, value: number) => {
      const wallet = (await client.call('POST', '/v1/wallets', { name, category: 'savings' })).body;
      return (
        await client.call('POST', '/v1/rules', {
          name,
          destinationType: 'wallet',
          destinationId: wallet.id,
          method: 'percentage',
          value,
          priority: 1,
        })
      ).body.id;
    };
    const a = await make('A', 7000);
    const b = await make('B', 4000);
    expect((await client.call('POST', `/v1/rules/${a}/activate`)).status).toBe(200);
    expect((await client.call('POST', `/v1/rules/${b}/activate`)).body.error.code).toBe('over_allocated');
    await client.call('PUT', `/v1/rules/${b}`, { name: 'B', method: 'percentage', value: 3000, priority: 2 });
    expect((await client.call('POST', `/v1/rules/${b}/activate`)).status).toBe(200);
    expect(
      (
        await client.call('PUT', `/v1/rules/${b}`, {
          name: 'B',
          method: 'percentage',
          value: 3001,
          priority: 2,
        })
      ).body.error.code,
    ).toBe('over_allocated');
  });

  it('refuses accounts the bank does not know, and duplicates', async () => {
    const { client } = await onboarded();
    const body = { name: 'Mum', category: 'family', bankCode: '058', accountNumber: '0123456713' };
    expect((await client.call('POST', '/v1/beneficiaries', body)).body.error.code).toBe('account_not_found');
    await client.call('POST', '/v1/beneficiaries', { ...body, accountNumber: '0123456743' });
    expect(
      (await client.call('POST', '/v1/beneficiaries', { ...body, accountNumber: '0123456743' })).body.error
        .code,
    ).toBe('beneficiary_exists');
  });

  it('will not remove a wallet that holds money', async () => {
    const { client, id } = await onboarded();
    const [user] = await h.ctx.db.select().from(users).where(eq(users.id, id));
    const wallet = await addWallet(h, user!, 'Savings');
    await addRule(h, user!, { type: 'wallet', id: wallet.id }, 'fixed', 10_000, 1);
    const account = (await client.call('GET', '/v1/salary-account')).body.account;
    const payIn = h.emulators.bankTransfer(account.accountNumber, 50_000);
    await h.webhook('charge.success', payIn.reference);
    await h.drain();
    expect((await client.call('DELETE', `/v1/wallets/${wallet.id}`)).body.error.code).toBe(
      'wallet_not_empty',
    );
    expect((await client.call('POST', '/v1/me/close', { password: PASSWORD })).body.error.code).toBe(
      'balance_remaining',
    );

    const list = (await client.call('GET', '/v1/transactions?group=wallet')).body;
    expect(list.total).toBe(1);
    const receipt = await client.call('GET', `/v1/transactions/${list.items[0].id}/receipt`);
    expect(receipt.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const today = new Date().toISOString().slice(0, 10);
    const csv = await client.call(
      'GET',
      `/v1/statements?from=${today}&to=${today}&format=csv&account=salary`,
    );
    expect(csv.body).toContain('Opening balance');
    const pdf = await client.call('GET', `/v1/statements?from=${today}&to=${today}&format=pdf&account=all`);
    expect(pdf.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const dash = (await client.call('GET', '/v1/dashboard')).body;
    expect(dash).toMatchObject({
      walletTotal: 10_000,
      account: { balance: 40_000 },
      period: { salaryReceived: 50_000, allocated: 10_000 },
    });
    expect((await client.call('GET', '/v1/me/export')).raw.headers['content-disposition']).toContain(
      'attachment',
    );
  });

  it('closes an empty account and frees nothing it should keep', async () => {
    const { client, id, email } = await onboarded();
    expect((await client.call('POST', '/v1/me/close', { password: PASSWORD })).status).toBe(200);
    expect((await client.call('GET', '/v1/me')).status).toBe(401);
    expect((await new Client().call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(
      401,
    );
    const [row] = await h.ctx.db.select().from(users).where(eq(users.id, id));
    expect(row).toMatchObject({ status: 'closed', phone: null });
    expect((await h.ctx.db.select().from(auditLogs).where(eq(auditLogs.userId, id))).length).toBeGreaterThan(
      3,
    );
  });
});

describe('administration', () => {
  it('keeps customers and administrators apart in both directions', async () => {
    const customer = await onboarded();
    expect((await customer.client.call('GET', '/v1/admin/overview')).status).toBe(401);
    expect(
      (await new Client().call('POST', '/v1/admin/auth/login', { email: customer.email, password: PASSWORD }))
        .status,
    ).toBe(401);
    const { client, email } = await adminClient();
    expect((await client.call('GET', '/v1/me')).status).toBe(401);
    expect((await new Client().call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(
      401,
    );
    customer.client.cookies.set('ps_admin', customer.client.cookies.get('ps_session')!);
    expect((await customer.client.call('GET', '/v1/admin/overview')).status).toBe(401);
  });

  it('pays a test salary in through the provider and splits it only once confirmed', async () => {
    const customer = await onboarded();
    const [user] = await h.ctx.db.select().from(users).where(eq(users.id, customer.id));
    const wallet = await addWallet(h, user!, 'Savings');
    await addRule(h, user!, { type: 'wallet', id: wallet.id }, 'percentage', 2000, 1);
    const { client } = await adminClient();

    const run = (await client.call('POST', '/v1/admin/pay-ins', { userId: customer.id, amount: 60_000_000 }))
      .body;
    expect(run).toMatchObject({ status: 'awaiting_confirmation', confirmedAmount: null, execution: null });
    expect(await h.ctx.db.$count(salaryPayments, eq(salaryPayments.userId, customer.id))).toBe(0);
    await h.webhook('charge.success', run.providerReference);
    await h.webhook('charge.success', run.providerReference);
    await h.drain();
    const done = (await client.call('GET', `/v1/admin/pay-ins/${run.id}`)).body;
    expect(done).toMatchObject({
      status: 'confirmed',
      confirmedAmount: 60_000_000,
      splitState: 'split',
      execution: { status: 'successful', toWallets: 12_000_000, remaining: 48_000_000 },
    });
    const [event] = await h.ctx.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.reference, run.providerReference));
    expect(event).toMatchObject({ deliveries: 2, status: 'processed' });

    const next = (await client.call('POST', '/v1/admin/pay-ins', { userId: customer.id, amount: 60_000_000 }))
      .body;
    expect(next.payCycle > done.payCycle).toBe(true);
    const detail = (await client.call('GET', `/v1/admin/users/${customer.id}`)).body;
    expect(detail.wallets[0].balance).toBe(12_000_000);
    expect((await client.call('GET', `/v1/admin/salary-transactions?userId=${customer.id}`)).body.total).toBe(
      1,
    );
    expect((await client.call('GET', `/v1/admin/users?q=${customer.email}`)).body.items[0]).toMatchObject({
      totalPaid: 60_000_000,
      ineligibleReason: null,
    });
  });

  it('refuses a pay-in to someone who is not eligible, and says why', async () => {
    const { client } = await adminClient();
    const { client: person } = await signedInUser();
    const id = (await person.call('GET', '/v1/me')).body.id;
    const refused = await client.call('POST', '/v1/admin/pay-ins', { userId: id, amount: 100_000 });
    expect(refused.body.error).toMatchObject({
      code: 'user_not_eligible',
      message: expect.stringContaining('not verified'),
    });
    expect(await h.ctx.db.$count(payinRuns, eq(payinRuns.userId, id))).toBe(0);
  });

  it('never claims success when the provider’s answer is lost, and recovers on refresh', async () => {
    const customer = await onboarded();
    const { client } = await adminClient();
    h.emulators.state.paystackDown = true;
    const run = (await client.call('POST', '/v1/admin/pay-ins', { userId: customer.id, amount: 100_000 }))
      .body;
    h.emulators.state.paystackDown = false;
    expect(run.status).toBe('awaiting_confirmation');
    expect((await client.call('POST', `/v1/admin/pay-ins/${run.id}/refresh`)).body.status).toBe(
      'awaiting_confirmation',
    );
  });

  it('records what administrators do', async () => {
    const { client } = await adminClient();
    await client.call('PATCH', '/v1/admin/me', {
      firstName: 'Marc',
      lastName: 'Vance',
      phone: '+2348030000000',
    });
    await client.call('POST', '/v1/admin/reconciliation/run');
    const actions = (await client.call('GET', '/v1/admin/audit?pageSize=20')).body.items.map(
      (i: { action: string }) => i.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['admin.login', 'admin.profile_updated', 'admin.reconciliation_run']),
    );
  });
});

describe('operations', () => {
  it('guards the tick endpoint and runs each window once', async () => {
    expect((await new Client().call('POST', '/internal/tick')).status).toBe(401);
    h.clock.advance(3_600_000);
    const [a, b] = await Promise.all([tick(h.ctx), tick(h.ctx)]);
    const names = [...a, ...b];
    expect(new Set(names).size).toBe(names.length);
    expect(await tick(h.ctx)).toEqual([]);
  });

  it('reminds about tomorrow’s salary once, and about a missing one', async () => {
    const tomorrow = new Date(h.clock.now.getTime() + 86_400_000);
    const day = Number(
      new Intl.DateTimeFormat('en', { timeZone: 'Africa/Lagos', day: 'numeric' }).format(tomorrow),
    );
    const user = await verifiedUser(h, { salaryDay: day, notificationPrefs: DEFAULT_PREFS });
    const wallet = await addWallet(h, user, 'Savings');
    await addRule(h, user, { type: 'wallet', id: wallet.id }, 'fixed', 1000, 1);
    const titles = async () =>
      (await h.ctx.db.query.notifications.findMany({ where: (n) => eq(n.userId, user.id) }))
        .map((n) => n.title)
        .filter((t) => t.startsWith('Salary'));
    for (let i = 0; i < 2; i++) {
      await h.ctx.db.execute('delete from paysplit.scheduled_runs' as never);
      await tick(h.ctx);
    }
    expect(await titles()).toEqual(['Salary expected tomorrow']);
    h.clock.advance(2 * 86_400_000);
    await h.ctx.db.execute('delete from paysplit.scheduled_runs' as never);
    await tick(h.ctx);
    expect(await titles()).toContain('Salary not received yet');
  });

  it('reports health and serves the API description', async () => {
    const client = new Client();
    expect((await client.call('GET', '/healthz')).body).toEqual({ ok: true });
    expect((await client.call('GET', '/readyz')).body).toEqual({ ok: true });
    expect((await client.call('GET', '/docs/json')).body.info.title).toBe('PaySplit API');
  });
});
