import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  COUNTRIES,
  DEFAULT_PREFS,
  country as countryConfig,
  normalizePhone,
  type IncomeInput,
  type NotificationPrefs,
  type ProfileInput,
  type RegisterInput,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { salaryAccounts, transfers, users, wallets, rules } from '../db/schema.ts';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors.ts';
import type { EmailProof } from '../ports/auth.ts';
import { audit, type RequestMeta } from './audit.ts';
import { balancesOf } from './ledger.ts';
import { notify, queueEmail } from './notifications.ts';
import { isNewDevice, openSession, revokeAll, type UserRow } from './sessions.ts';

const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

/** Slows password guessing against one account, whatever address it comes from. */
export function assertNotLocked(ctx: Ctx, key: string): void {
  const entry = failures.get(key);
  if (entry && entry.resetAt > ctx.now().getTime() && entry.count >= MAX_FAILURES) {
    throw new AppError(
      429,
      'too_many_attempts',
      'Too many attempts. Wait 15 minutes or reset your password.',
    );
  }
}

export function recordFailure(ctx: Ctx, key: string): void {
  const now = ctx.now().getTime();
  const entry = failures.get(key);
  failures.set(
    key,
    entry && entry.resetAt > now
      ? { ...entry, count: entry.count + 1 }
      : { count: 1, resetAt: now + FAILURE_WINDOW_MS },
  );
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

async function sendVerification(
  ctx: Ctx,
  user: { id: string; email: string; firstName: string },
  proof: EmailProof,
): Promise<void> {
  await queueEmail(ctx.db, {
    to: user.email,
    userId: user.id,
    template: 'verify_email',
    dedupeKey: `verify:${sha256(proof.token)}`,
    sensitive: true,
    content: {
      subject: 'Verify your PaySplit email',
      heading: `Welcome, ${user.firstName}`,
      paragraphs: [
        'Enter this code to verify your email address, or use the button. Both expire in one hour.',
      ],
      code: proof.code,
      button: {
        label: 'Verify email',
        url: `${ctx.config.APP_URL}/verify-email?token=${encodeURIComponent(proof.token)}`,
      },
      footnote: 'If you did not create a PaySplit account, ignore this email.',
    },
  });
}

/**
 * Registers a person and emails a code and link. The answer is the same whether or not the address is taken,
 * so the form cannot be used to find out who has an account.
 *
 * Returns a nonce for the registering browser. Registering again before verifying replaces the password, so the
 * nonce tells `verifyEmail` whether the person verifying is the one who chose it.
 */
export async function register(
  ctx: Ctx,
  input: RegisterInput,
  meta: RequestMeta,
): Promise<{ nonce: string }> {
  const nonce = randomToken();
  const created = await ctx.auth.createUser({ email: input.email, password: input.password });
  if (created === 'email_taken') {
    await queueEmail(ctx.db, {
      to: input.email,
      template: 'register_existing',
      dedupeKey: `register-existing:${input.email}:${ctx.now().toISOString().slice(0, 13)}`,
      content: {
        subject: 'You already have a PaySplit account',
        heading: 'You already have an account',
        paragraphs: [
          'Someone tried to create a PaySplit account with this email address. Sign in instead, or reset your password if you forgot it.',
        ],
        button: { label: 'Sign in', url: `${ctx.config.APP_URL}/login` },
      },
    });
    return { nonce };
  }

  // Registering again before verifying must use the newest password. Setting it also cancels earlier links, so
  // the proof is issued afterwards.
  await ctx.auth.setPassword(created.authId, input.password);
  const values = { firstName: input.firstName, lastName: input.lastName, pendingNonceHash: sha256(nonce) };
  const [user] = await ctx.db
    .insert(users)
    .values({ ...values, authId: created.authId, email: input.email, notificationPrefs: DEFAULT_PREFS })
    .onConflictDoUpdate({ target: users.authId, set: values })
    .returning();
  await audit(ctx.db, {
    actor: { type: 'user', id: user!.id },
    userId: user!.id,
    action: 'account.registered',
    meta,
  });
  await sendVerification(ctx, user!, await ctx.auth.issueVerification(input.email));
  return { nonce };
}

export async function resendVerification(ctx: Ctx, email: string): Promise<void> {
  const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
  if (!user || user.emailVerifiedAt || user.status !== 'active') return;
  await sendVerification(ctx, user, await ctx.auth.issueVerification(email));
}

export type VerifyOutcome =
  | { next: 'signed_in'; session: Awaited<ReturnType<typeof openSession>> }
  | { next: 'set_password'; token: string };

/**
 * Confirms an email address. When the browser is not the one that registered, the password on the account may
 * have been chosen by someone else, so it is scrambled and the owner of the inbox sets a new one.
 */
export async function verifyEmail(
  ctx: Ctx,
  proof: { token: string } | { email: string; code: string },
  nonce: string | undefined,
  meta: RequestMeta,
): Promise<VerifyOutcome> {
  if ('email' in proof) assertNotLocked(ctx, `verify:${proof.email}`);
  const redeemed = await ctx.auth.redeem(proof, 'email');
  if (!redeemed) {
    if ('email' in proof) recordFailure(ctx, `verify:${proof.email}`);
    throw badRequest('invalid_code', 'That code or link is wrong or has expired. Request a new one.');
  }
  const [user] = await ctx.db.select().from(users).where(eq(users.authId, redeemed.authId));
  if (!user || user.status !== 'active') throw unauthorized();

  const provenBrowser =
    nonce && user.pendingNonceHash ? safeEqual(sha256(nonce), user.pendingNonceHash) : false;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ emailVerifiedAt: user.emailVerifiedAt ?? ctx.now(), pendingNonceHash: null })
      .where(eq(users.id, user.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'account.email_verified',
      meta,
    });
    await notify(tx, {
      userId: user.id,
      type: 'welcome',
      dedupeKey: `welcome:${user.id}`,
      severity: 'success',
      title: `Welcome to PaySplit, ${user.firstName}`,
      body: 'Verify your identity to get your dedicated salary account and start splitting.',
      link: '/onboarding',
      email: {
        content: {
          subject: 'Welcome to PaySplit',
          paragraphs: [
            'Your email is verified. Next, confirm your identity to get a dedicated salary account and activate your split rules.',
          ],
          button: { label: 'Continue setup', url: `${ctx.config.APP_URL}/onboarding` },
        },
      },
    });
  });

  if (provenBrowser)
    return { next: 'signed_in', session: await openSession(ctx, ctx.db, { userId: user.id }, { meta }) };
  await ctx.auth.setPassword(user.authId, `${randomToken()}Aa1`);
  const recovery = await ctx.auth.issueRecovery(user.email);
  return { next: 'set_password', token: recovery!.token };
}

export async function login(
  ctx: Ctx,
  input: { email: string; password: string; remember: boolean },
  meta: RequestMeta,
) {
  const key = `login:${input.email}`;
  assertNotLocked(ctx, key);
  const result = await ctx.auth.checkPassword(input.email, input.password);
  if (result === 'unverified') throw forbidden('email_unverified', 'Verify your email before signing in.');
  const [user] =
    result === 'invalid'
      ? []
      : await ctx.db
          .select()
          .from(users)
          .where(and(eq(users.authId, result.authId), eq(users.status, 'active')));
  if (!user) {
    recordFailure(ctx, key);
    const [known] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    await audit(ctx.db, { actor: { type: 'system' }, userId: known?.id, action: 'login.failed', meta });
    throw unauthorized('Email or password is incorrect');
  }
  clearFailures(key);
  const unfamiliar = await isNewDevice(ctx, user.id, meta.userAgent);
  const session = await openSession(ctx, ctx.db, { userId: user.id }, { remember: input.remember, meta });
  await audit(ctx.db, {
    actor: { type: 'user', id: user.id },
    userId: user.id,
    action: 'login.succeeded',
    meta,
  });
  if (unfamiliar) {
    await notify(ctx.db, {
      userId: user.id,
      type: 'new_login',
      dedupeKey: `login:${sha256(session.token).slice(0, 24)}`,
      severity: 'warning',
      title: 'New sign-in to your account',
      body: 'Your account was opened from a browser we have not seen before. If this was not you, change your password.',
      link: '/settings',
      email: {
        content: {
          subject: 'New sign-in to your PaySplit account',
          paragraphs: [
            'Your account was opened from a browser we have not seen before. If this was you, there is nothing to do. If not, change your password now.',
          ],
          rows: [
            ['When', ctx.now().toUTCString()],
            ['Browser', meta.userAgent?.slice(0, 80) ?? 'Unknown'],
          ],
          button: { label: 'Review security', url: `${ctx.config.APP_URL}/settings` },
        },
      },
    });
  }
  return { user, session };
}

export async function forgotPassword(
  ctx: Ctx,
  email: string,
  audience: 'user' | 'admin',
  recipientExists: boolean,
): Promise<void> {
  if (!recipientExists) return;
  const proof = await ctx.auth.issueRecovery(email);
  if (!proof) return;
  const path = audience === 'admin' ? '/admin/reset-password' : '/reset-password';
  await queueEmail(ctx.db, {
    to: email,
    template: 'reset_password',
    dedupeKey: `reset:${sha256(proof.token)}`,
    sensitive: true,
    content: {
      subject: 'Reset your PaySplit password',
      heading: 'Reset your password',
      paragraphs: ['Use the button to choose a new password. The link works once and expires in one hour.'],
      button: {
        label: 'Choose a new password',
        url: `${ctx.config.APP_URL}${path}?token=${encodeURIComponent(proof.token)}`,
      },
      footnote: 'If you did not ask for this, ignore this email. Your password has not changed.',
    },
  });
}

/** Sets a new password from a reset link and signs every device out. */
export async function resetPassword(
  ctx: Ctx,
  token: string,
  password: string,
  meta: RequestMeta,
): Promise<void> {
  const redeemed = await ctx.auth.redeem({ token }, 'recovery');
  if (!redeemed)
    throw badRequest('invalid_link', 'This reset link is wrong, used or expired. Request a new one.');
  const [user] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.authId, redeemed.authId), eq(users.status, 'active')));
  if (!user) throw badRequest('invalid_link', 'This reset link is not for a customer account.');
  await ctx.auth.setPassword(redeemed.authId, password);
  await afterPasswordChange(ctx, user, 'password.reset', meta);
}

export async function changePassword(
  ctx: Ctx,
  user: UserRow,
  sessionId: string,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<void> {
  await requirePassword(ctx, user.email, input.currentPassword);
  await ctx.auth.setPassword(user.authId, input.newPassword);
  await afterPasswordChange(ctx, user, 'password.changed', meta, sessionId);
}

export async function requirePassword(ctx: Ctx, email: string, password: string): Promise<void> {
  const key = `confirm:${email}`;
  assertNotLocked(ctx, key);
  const result = await ctx.auth.checkPassword(email, password);
  if (typeof result === 'string') {
    recordFailure(ctx, key);
    throw badRequest('wrong_password', 'Your current password is incorrect');
  }
  clearFailures(key);
}

async function afterPasswordChange(
  ctx: Ctx,
  user: UserRow,
  action: string,
  meta: RequestMeta,
  keepSession?: string,
) {
  await ctx.db.transaction(async (tx) => {
    await revokeAll(ctx, tx, { userId: user.id }, keepSession);
    await tx.update(users).set({ passwordChangedAt: ctx.now() }).where(eq(users.id, user.id));
    await audit(tx, { actor: { type: 'user', id: user.id }, userId: user.id, action, meta });
    await notify(tx, {
      userId: user.id,
      type: 'password_changed',
      dedupeKey: `password:${user.id}:${ctx.now().toISOString()}`,
      severity: 'warning',
      title: 'Your password was changed',
      body: 'Other devices were signed out. If this was not you, reset your password now.',
      link: '/settings',
      email: {
        content: {
          subject: 'Your PaySplit password was changed',
          paragraphs: [
            'Your password was changed and your other devices were signed out. If this was not you, reset it now.',
          ],
          button: { label: 'Reset password', url: `${ctx.config.APP_URL}/forgot-password` },
        },
      },
    });
  });
}

export async function setProfile(
  ctx: Ctx,
  user: UserRow,
  input: ProfileInput,
  meta: RequestMeta,
): Promise<void> {
  if (['approved', 'pending_review'].includes(user.kycStatus) && user.country !== input.country) {
    throw conflict('country_locked', 'Your country cannot change after verification. Contact support.');
  }
  const config = countryConfig(input.country)!;
  const phone = normalizePhone(input.phone, input.country)!;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ country: input.country, phone, timezone: config.timezone })
      .where(eq(users.id, user.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'profile.set',
      metadata: { country: input.country },
      meta,
    });
  });
}

export async function updateMe(
  ctx: Ctx,
  user: UserRow,
  input: { firstName: string; lastName: string; phone?: string | undefined },
  meta: RequestMeta,
) {
  const nameChanged = input.firstName !== user.firstName || input.lastName !== user.lastName;
  if (nameChanged && user.kycStatus === 'approved') {
    throw conflict('name_locked', 'Your name was verified and cannot be edited here. Contact support.');
  }
  let phone = user.phone;
  if (input.phone && user.country) {
    phone = normalizePhone(input.phone, user.country);
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid phone number for your country');
  }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ firstName: input.firstName, lastName: input.lastName, phone })
      .where(eq(users.id, user.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'profile.updated',
      meta,
    });
  });
}

export async function setIncome(
  ctx: Ctx,
  user: UserRow,
  input: IncomeInput,
  meta: RequestMeta,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        employer: input.employer || null,
        expectedSalary: input.expectedSalary ? BigInt(input.expectedSalary) : null,
        salaryDay: input.salaryDay,
      })
      .where(eq(users.id, user.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'income.updated',
      metadata: { salaryDay: input.salaryDay },
      meta,
    });
  });
}

export async function setPrefs(ctx: Ctx, user: UserRow, prefs: NotificationPrefs): Promise<void> {
  await ctx.db.update(users).set({ notificationPrefs: prefs }).where(eq(users.id, user.id));
}

/**
 * Closes an account that holds no money. Financial records and the audit trail are kept; the sign-in and
 * contact details are removed.
 */
export async function closeAccount(
  ctx: Ctx,
  user: UserRow,
  password: string,
  meta: RequestMeta,
): Promise<void> {
  await requirePassword(ctx, user.email, password);
  await ctx.db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(salaryAccounts)
      .where(eq(salaryAccounts.userId, user.id))
      .for('update');
    const owned = await tx
      .select({ id: wallets.ledgerAccountId })
      .from(wallets)
      .where(eq(wallets.userId, user.id));
    const balances = await balancesOf(tx, [
      ...owned.map((w) => w.id),
      ...(account ? [account.ledgerAccountId] : []),
    ]);
    if ([...balances.values()].some((b) => b > 0n)) {
      throw conflict('balance_remaining', 'Your account still holds money. Empty it before closing.');
    }
    const open = await tx
      .select({ id: transfers.id })
      .from(transfers)
      .where(
        and(
          eq(transfers.userId, user.id),
          inArray(transfers.status, ['queued', 'in_flight', 'unknown', 'retrying']),
        ),
      );
    if (open.length)
      throw conflict('transfers_pending', 'A transfer is still in progress. Try again when it finishes.');

    await tx
      .update(rules)
      .set({ status: 'deleted', deletedAt: ctx.now() })
      .where(and(eq(rules.userId, user.id), sql`status <> 'deleted'`));
    await revokeAll(ctx, tx, { userId: user.id });
    await tx
      .update(users)
      .set({
        status: 'closed',
        closedAt: ctx.now(),
        email: `closed+${user.id}@paysplit.invalid`,
        phone: null,
        employer: null,
      })
      .where(eq(users.id, user.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'account.closed',
      meta,
    });
  });
  await ctx.auth.deleteUser(user.authId);
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    country: user.country,
    countryName: COUNTRIES.find((c) => c.code === user.country)?.name ?? null,
    phone: user.phone,
    timezone: user.timezone,
    employer: user.employer,
    expectedSalary: user.expectedSalary === null ? null : Number(user.expectedSalary),
    salaryDay: user.salaryDay,
    kycStatus: user.kycStatus,
    tier: user.kycStatus === 'approved' ? 2 : 1,
    notificationPrefs: { ...DEFAULT_PREFS, ...user.notificationPrefs },
    passwordChangedAt: user.passwordChangedAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
  };
}

export type PublicUser = ReturnType<typeof publicUser>;
