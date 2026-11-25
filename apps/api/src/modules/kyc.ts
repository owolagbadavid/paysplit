import { and, desc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { country as countryConfig } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import type { Tx } from '../db/client.ts';
import { kycCases, users } from '../db/schema.ts';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  ProviderError,
  unavailable,
  unprocessable,
} from '../lib/errors.ts';
import type { VerificationProvider } from '../ports/verification.ts';
import { audit, type RequestMeta } from './audit.ts';
import { enqueue } from './jobs.ts';
import { notify } from './notifications.ts';
import { prepareSalaryAccount } from './salary-accounts.ts';
import type { UserRow } from './sessions.ts';

const MAX_CASES_PER_DAY = 5;
const MAX_LIVENESS_ATTEMPTS = 3;
const NUMBER_RETENTION_MS = 24 * 3_600_000;

/** Why a case waits for a person. Shown to administrators and to its owner. */
const INCONCLUSIVE = 'The provider could not decide from the photo, so a person is reviewing it.';

type CaseRow = typeof kycCases.$inferSelect;

async function latestCase(ctx: Ctx, userId: string): Promise<CaseRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(kycCases)
    .where(eq(kycCases.userId, userId))
    .orderBy(desc(kycCases.createdAt))
    .limit(1);
  return row;
}

export type KycStep = 'profile' | 'identity' | 'liveness' | 'done' | 'unsupported' | 'review';

export async function kycState(ctx: Ctx, user: UserRow) {
  const config = countryConfig(user.country);
  const current = await latestCase(ctx, user.id);
  const open = current && ['in_progress', 'action_required'].includes(current.status) ? current : undefined;
  let step: KycStep;
  if (user.kycStatus === 'approved') step = 'done';
  else if (user.kycStatus === 'pending_review') step = 'review';
  else if (!user.country || !user.phone) step = 'profile';
  else if (!config?.launched) step = 'unsupported';
  else step = open?.identityStatus === 'passed' ? 'liveness' : 'identity';
  return {
    status: user.kycStatus,
    step,
    country: user.country,
    identityOptions: config?.identityOptions ?? [],
    reason: current?.reason ?? null,
    attemptsLeft: open ? Math.max(0, MAX_LIVENESS_ATTEMPTS - open.livenessAttempts) : MAX_LIVENESS_ATTEMPTS,
    identity: current
      ? {
          type: current.identityType,
          last4: current.identityLast4,
          status: current.identityStatus,
          checkedAt: current.identityCheckedAt,
        }
      : null,
    liveness: current ? { status: current.livenessStatus, checkedAt: current.livenessCheckedAt } : null,
  };
}

function providerFor(ctx: Ctx, user: UserRow): VerificationProvider {
  if (!user.country || !user.phone)
    throw conflict('profile_incomplete', 'Add your country and phone number first');
  const provider = ctx.verification.forCountry(user.country);
  if (!provider)
    throw unprocessable('country_not_supported', 'Verification is not available in your country yet');
  return provider;
}

/** Turns a provider outage into an answer that leaves the person's status alone. Nothing is decided on a timeout. */
async function ask<T>(ctx: Ctx, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderError) {
      ctx.log.warn({ err: error }, 'verification provider problem');
      if (error.kind === 'rejected')
        throw unprocessable(
          'verification_refused',
          'The verification provider could not read that. Check it and try again.',
        );
      throw unavailable(
        'The verification provider is not responding. Your progress is saved, so try again shortly.',
      );
    }
    throw error;
  }
}

const normalizeName = (value: string | undefined) =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();

/** Looks the chosen identifier up in the national registry and, when it matches, moves on to liveness. */
export async function submitIdentity(
  ctx: Ctx,
  user: UserRow,
  input: { type: string; number: string },
  meta: RequestMeta,
) {
  if (user.kycStatus === 'approved') throw conflict('already_verified', 'You are already verified');
  if (user.kycStatus === 'pending_review') throw conflict('in_review', 'Your verification is being reviewed');
  const provider = providerFor(ctx, user);
  if (!provider.identityTypes.includes(input.type))
    throw badRequest('unsupported_identity', 'Choose one of the listed identity types');

  const since = new Date(ctx.now().getTime() - 86_400_000);
  const recent = await ctx.db.$count(
    kycCases,
    and(eq(kycCases.userId, user.id), gt(kycCases.createdAt, since)),
  );
  if (recent >= MAX_CASES_PER_DAY)
    throw new AppError(
      429,
      'too_many_attempts',
      'You have reached today’s verification attempts. Try again tomorrow.',
    );

  const fingerprint = ctx.vault.fingerprint(input.type, input.number);
  // Sandbox registries publish one shared test number, so reuse is only a signal outside the sandbox.
  if (!ctx.config.kycSandbox) {
    const [taken] = await ctx.db
      .select({ id: kycCases.id })
      .from(kycCases)
      .where(
        and(
          eq(kycCases.identityFingerprint, fingerprint),
          eq(kycCases.status, 'approved'),
          ne(kycCases.userId, user.id),
        ),
      );
    if (taken)
      throw conflict(
        'identity_in_use',
        'This identity is already verified on another account. Contact support.',
      );
  }

  const result = await ask(ctx, () => provider.lookupIdentity(input));
  const nameMatch =
    result.found &&
    normalizeName(result.lastName) === normalizeName(user.lastName) &&
    normalizeName(result.firstName) === normalizeName(user.firstName);
  // The sandbox returns the same fixed person for everyone, so a mismatch is recorded there but not enforced.
  const reason = !result.found
    ? 'We could not find that number. Check it and try again.'
    : !nameMatch && !ctx.config.kycSandbox
      ? 'The name on that record does not match your profile. Correct your name or use another identity.'
      : null;

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(kycCases)
      .set({ status: 'superseded', identityNumberEnc: null })
      .where(and(eq(kycCases.userId, user.id), sql`status in ('in_progress','action_required')`));
    await tx.insert(kycCases).values({
      userId: user.id,
      country: user.country!,
      provider: provider.name,
      status: reason ? 'action_required' : 'in_progress',
      identityType: input.type,
      identityLast4: input.number.slice(-4),
      identityFingerprint: fingerprint,
      identityNumberEnc: reason ? null : ctx.vault.encrypt(input.number, `kyc:${user.id}`),
      identityStatus: reason ? 'failed' : 'passed',
      identityCheckedAt: ctx.now(),
      nameMatch,
      reason,
    });
    await setStatus(tx, user, reason ? 'action_required' : 'in_progress');
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: reason ? 'kyc.identity_failed' : 'kyc.identity_passed',
      metadata: { type: input.type, provider: provider.name },
      meta,
    });
  });
  if (reason) throw unprocessable('identity_not_verified', reason);
}

/**
 * Checks that a live person is present and that their face matches the identity record, then settles the case. When
 * the provider's verdict says nothing about this photo, the case waits for an administrator instead.
 */
export async function submitLiveness(ctx: Ctx, user: UserRow, image: string, meta: RequestMeta) {
  const provider = providerFor(ctx, user);
  const current = await latestCase(ctx, user.id);
  if (
    !current?.identityNumberEnc ||
    current.identityStatus !== 'passed' ||
    !['in_progress', 'action_required'].includes(current.status)
  ) {
    throw conflict('identity_first', 'Verify your BVN or NIN before the liveness check');
  }
  if (current.livenessAttempts >= MAX_LIVENESS_ATTEMPTS)
    throw conflict('attempts_used', 'No attempts left. Start again with your BVN or NIN.');

  const imageBase64 = image.replace(/^data:image\/\w+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(imageBase64))
    throw badRequest('invalid_image', 'That photo could not be read. Take it again.');

  const number = ctx.vault.decrypt(current.identityNumberEnc, `kyc:${user.id}`);
  const liveness = await ask(ctx, () => provider.checkLiveness(imageBase64));
  const worthMatching =
    !liveness.conclusive || (liveness.live && liveness.faceDetected && !liveness.multipleFaces);
  const match = worthMatching
    ? await ask(ctx, () => provider.matchFace({ type: current.identityType, number, imageBase64 }))
    : null;

  const problem = !liveness.conclusive
    ? null
    : !liveness.faceDetected
      ? 'We could not see a face. Centre your face in the frame in good light.'
      : liveness.multipleFaces
        ? 'More than one face was in the frame. Take the photo alone.'
        : !liveness.live
          ? 'We could not confirm a live person. Look straight at the camera and try again.'
          : !match!.matched
            ? 'Your face did not match the photo on your identity record.'
            : null;

  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(kycCases).where(eq(kycCases.id, current.id)).for('update');
    if (!locked || !['in_progress', 'action_required'].includes(locked.status))
      throw conflict('case_changed', 'This verification has moved on. Refresh and try again.');
    const attempts = locked.livenessAttempts + 1;
    const exhausted = problem !== null && attempts >= MAX_LIVENESS_ATTEMPTS;
    const status: CaseOutcome | 'action_required' = !liveness.conclusive
      ? 'pending_review'
      : problem === null
        ? 'approved'
        : exhausted
          ? 'rejected'
          : 'action_required';
    const settled = status !== 'action_required';
    const livenessStatus = { approved: 'passed', pending_review: 'in_review', rejected: 'failed' };
    await tx
      .update(kycCases)
      .set({
        status,
        livenessStatus: status === 'action_required' ? 'failed' : livenessStatus[status],
        livenessAttempts: attempts,
        livenessCheckedAt: ctx.now(),
        livenessScore: Math.round(liveness.score),
        matchScore: match ? Math.round(match.score) : null,
        reason: status === 'pending_review' ? INCONCLUSIVE : problem,
        ...(settled ? { identityNumberEnc: null } : {}),
      })
      .where(eq(kycCases.id, current.id));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: {
        approved: 'kyc.approved',
        pending_review: 'kyc.sent_to_review',
        rejected: 'kyc.liveness_failed',
        action_required: 'kyc.liveness_failed',
      }[status],
      target: { type: 'kyc_case', id: current.id },
      metadata: { attempts },
      meta,
    });
    await setStatus(tx, user, status);
    if (status !== 'action_required') await settleCase(ctx, tx, user, current.id, status, problem);
  });
  if (problem) throw unprocessable('liveness_failed', problem);
}

type CaseOutcome = 'approved' | 'rejected' | 'pending_review';

/** What follows a decision: the salary account for an approval, and telling the person either way. */
async function settleCase(
  ctx: Ctx,
  tx: Tx,
  user: UserRow,
  caseId: string,
  outcome: CaseOutcome,
  problem: string | null,
): Promise<void> {
  if (outcome === 'approved') {
    await prepareSalaryAccount(tx, user.id, ctx.payments.name);
    await enqueue(tx, 'salary_account.provision', { userId: user.id }, { dedupeKey: `provision:${user.id}` });
  }
  const message = {
    approved: {
      severity: 'success' as const,
      title: 'Identity approved',
      body: 'Your verification is complete. Your salary account is being set up.',
      link: '/dashboard',
      subject: 'Your identity is verified',
      paragraphs: [
        'Your identity and liveness checks are approved. We are setting up your dedicated salary account now.',
      ],
    },
    pending_review: {
      severity: 'info' as const,
      title: 'Verification in review',
      body: 'We have your details and will tell you when there is a decision.',
      link: '/onboarding',
      subject: 'Your verification is being reviewed',
      paragraphs: [
        'We have your identity details and selfie check. Someone is reviewing them, and you do not need to do anything.',
      ],
    },
    rejected: {
      severity: 'error' as const,
      title: 'We could not verify you',
      body: `${problem} You can start again.`,
      link: '/onboarding',
      subject: 'Your verification was not successful',
      paragraphs: [problem ?? '', 'You can start again from your dashboard.'],
    },
  }[outcome];
  await notify(tx, {
    userId: user.id,
    type: `kyc_${outcome}`,
    dedupeKey: `kyc:${caseId}:${outcome}`,
    severity: message.severity,
    title: message.title,
    body: message.body,
    link: message.link,
    email: {
      content: {
        subject: message.subject,
        paragraphs: message.paragraphs,
        button: { label: 'Open PaySplit', url: `${ctx.config.APP_URL}${message.link}` },
      },
    },
  });
}

/** An administrator's decision on a case the provider could not settle. */
export async function reviewCase(
  ctx: Ctx,
  adminId: string,
  userId: string,
  input: { decision: 'approve' | 'reject'; note: string },
  meta: RequestMeta,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user) throw notFound('User');
    const [open] = await tx
      .select()
      .from(kycCases)
      .where(and(eq(kycCases.userId, userId), eq(kycCases.status, 'pending_review')))
      .for('update');
    if (!open || user.status !== 'active')
      throw conflict('not_in_review', 'This verification is not waiting for a review');
    const status = input.decision === 'approve' ? ('approved' as const) : ('rejected' as const);
    const problem = status === 'rejected' ? 'We could not confirm your identity from what you sent.' : null;
    await tx
      .update(kycCases)
      .set({
        status,
        livenessStatus: status === 'approved' ? 'reviewed' : 'failed',
        reason: problem,
      })
      .where(eq(kycCases.id, open.id));
    await setStatus(tx, user, status);
    await audit(tx, {
      actor: { type: 'admin', id: adminId },
      userId,
      action: `admin.kyc_${status}`,
      target: { type: 'kyc_case', id: open.id },
      metadata: { note: input.note, livenessScore: open.livenessScore, matchScore: open.matchScore },
      meta,
    });
    await settleCase(ctx, tx, user, open.id, status, problem);
  });
}

async function setStatus(tx: Tx, user: UserRow, status: string): Promise<void> {
  await tx.update(users).set({ kycStatus: status }).where(eq(users.id, user.id));
}

/** Erases identity numbers left by people who never finished, and sends them back to the identity step. */
export async function eraseStaleIdentityNumbers(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.now().getTime() - NUMBER_RETENTION_MS);
  await ctx.db
    .update(kycCases)
    .set({
      identityNumberEnc: null,
      status: 'expired',
      identityStatus: 'expired',
      reason: 'Your earlier attempt expired. Start again.',
    })
    .where(and(isNotNull(kycCases.identityNumberEnc), lt(kycCases.createdAt, cutoff)));
}
