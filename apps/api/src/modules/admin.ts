import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { addCycles, payCycleFor } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import {
  admins,
  auditLogs,
  executions,
  kycCases,
  payinRuns,
  reconciliationIssues,
  salaryAccounts,
  salaryPayments,
  users,
} from '../db/schema.ts';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  ProviderError,
  unauthorized,
  unprocessable,
} from '../lib/errors.ts';
import { assertNotLocked, clearFailures, publicUser, recordFailure, requirePassword } from './accounts.ts';
import { audit, type RequestMeta } from './audit.ts';
import { listBeneficiaries } from './beneficiaries.ts';
import { enqueue } from './jobs.ts';
import { rulesOverview } from './rules.ts';
import { creditPayIn } from './salary-payments.ts';
import { openSession, revokeAll, type AdminRow } from './sessions.ts';
import { executionDetail, listExecutions } from './splits.ts';
import { listTransactions } from './transactions.ts';
import { listWallets, salaryAccountView } from './wallets.ts';

export async function adminLogin(ctx: Ctx, input: { email: string; password: string }, meta: RequestMeta) {
  const key = `admin:${input.email}`;
  assertNotLocked(ctx, key);
  const result = await ctx.auth.checkPassword(input.email, input.password);
  const [admin] =
    typeof result === 'string'
      ? []
      : await ctx.db
          .select()
          .from(admins)
          .where(and(eq(admins.authId, result.authId), eq(admins.status, 'active')));
  if (!admin) {
    recordFailure(ctx, key);
    await audit(ctx.db, {
      actor: { type: 'system' },
      action: 'admin.login_failed',
      metadata: { email: input.email },
      meta,
    });
    throw unauthorized('Email or password is incorrect');
  }
  clearFailures(key);
  const session = await openSession(ctx, ctx.db, { adminId: admin.id }, { meta });
  await audit(ctx.db, { actor: { type: 'admin', id: admin.id }, action: 'admin.login', meta });
  return { admin, session };
}

export async function adminResetPassword(
  ctx: Ctx,
  token: string,
  password: string,
  meta: RequestMeta,
): Promise<void> {
  const redeemed = await ctx.auth.redeem({ token }, 'recovery');
  const [admin] = redeemed
    ? await ctx.db
        .select()
        .from(admins)
        .where(and(eq(admins.authId, redeemed.authId), eq(admins.status, 'active')))
    : [];
  if (!admin)
    throw badRequest('invalid_link', 'This reset link is wrong, used or expired. Request a new one.');
  await ctx.auth.setPassword(admin.authId, password);
  await ctx.db.transaction(async (tx) => {
    await revokeAll(ctx, tx, { adminId: admin.id });
    await tx.update(admins).set({ passwordChangedAt: ctx.now() }).where(eq(admins.id, admin.id));
    await audit(tx, { actor: { type: 'admin', id: admin.id }, action: 'admin.password_reset', meta });
  });
}

export async function adminChangePassword(
  ctx: Ctx,
  admin: AdminRow,
  sessionId: string,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
) {
  await requirePassword(ctx, admin.email, input.currentPassword);
  await ctx.auth.setPassword(admin.authId, input.newPassword);
  await ctx.db.transaction(async (tx) => {
    await revokeAll(ctx, tx, { adminId: admin.id }, sessionId);
    await tx.update(admins).set({ passwordChangedAt: ctx.now() }).where(eq(admins.id, admin.id));
    await audit(tx, { actor: { type: 'admin', id: admin.id }, action: 'admin.password_changed', meta });
  });
}

export async function updateAdmin(
  ctx: Ctx,
  admin: AdminRow,
  input: { firstName: string; lastName: string; phone?: string | null | undefined },
  meta: RequestMeta,
) {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(admins)
      .set({ firstName: input.firstName, lastName: input.lastName, phone: input.phone || null })
      .where(eq(admins.id, admin.id));
    await audit(tx, { actor: { type: 'admin', id: admin.id }, action: 'admin.profile_updated', meta });
  });
}

export function adminView(admin: AdminRow) {
  return {
    id: admin.id,
    email: admin.email,
    firstName: admin.firstName,
    lastName: admin.lastName,
    phone: admin.phone,
    passwordChangedAt: admin.passwordChangedAt,
    createdAt: admin.createdAt,
  };
}

export async function overview(ctx: Ctx) {
  const [row] = await ctx.db
    .select({
      total: count(),
      verified: sql<number>`count(*) filter (where ${users.kycStatus} = 'approved')::int`,
      pending: sql<number>`count(*) filter (where ${users.kycStatus} in ('in_progress','pending_review','action_required'))::int`,
    })
    .from(users)
    .where(eq(users.status, 'active'));
  const [paid] = await ctx.db
    .select({
      total: sql<string>`coalesce(sum(${salaryPayments.amount}), 0)`,
      people: sql<number>`count(distinct ${salaryPayments.userId})::int`,
    })
    .from(salaryPayments);
  const [issues] = await ctx.db
    .select({ n: count() })
    .from(reconciliationIssues)
    .where(and(eq(reconciliationIssues.status, 'open'), sql`severity <> 'info'`));
  return {
    totalUsers: row!.total,
    verifiedUsers: row!.verified,
    unverifiedUsers: row!.total - row!.verified,
    pendingVerification: row!.pending,
    totalSalaryPaid: Number(paid!.total),
    paidUsers: paid!.people,
    openIssues: issues!.n,
  };
}

const like = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

function ineligibleReason(row: {
  kycStatus: string;
  accountStatus: string | null;
  status: string;
}): string | null {
  if (row.status !== 'active') return 'Account closed';
  if (row.kycStatus !== 'approved') return 'Not verified';
  if (row.accountStatus === 'failed') return 'Salary account could not be set up';
  if (row.accountStatus !== 'active') return 'Salary account not ready';
  return null;
}

export async function listUsers(
  ctx: Ctx,
  filter: {
    q?: string | undefined;
    verification?: 'verified' | 'unverified' | 'review' | undefined;
    page: number;
    pageSize: number;
  },
) {
  const where = and(
    filter.q
      ? or(
          ilike(users.email, like(filter.q)),
          ilike(sql`${users.firstName} || ' ' || ${users.lastName}`, like(filter.q)),
        )
      : undefined,
    filter.verification === 'verified'
      ? eq(users.kycStatus, 'approved')
      : filter.verification === 'unverified'
        ? sql`${users.kycStatus} <> 'approved'`
        : filter.verification === 'review'
          ? eq(users.kycStatus, 'pending_review')
          : undefined,
    eq(users.status, 'active'),
  );
  const [rows, [total]] = await Promise.all([
    ctx.db
      .select({
        user: users,
        account: salaryAccounts,
        paid: sql<string>`(select coalesce(sum(p.amount), 0) from ${salaryPayments} p where p.user_id = ${users.id})`,
        lastPaid: sql<
          string | null
        >`(select p.amount from ${salaryPayments} p where p.user_id = ${users.id} order by p.paid_at desc limit 1)`,
      })
      .from(users)
      .leftJoin(salaryAccounts, eq(salaryAccounts.userId, users.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    ctx.db.select({ n: count() }).from(users).where(where),
  ]);
  return {
    items: rows.map(({ user, account, paid, lastPaid }) => ({
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      country: publicUser(user).countryName,
      emailVerified: user.emailVerifiedAt !== null,
      kycStatus: user.kycStatus,
      salaryDay: user.salaryDay,
      expectedSalary: user.expectedSalary === null ? null : Number(user.expectedSalary),
      accountBank: account?.bankName ?? null,
      accountMasked: account?.accountNumber ? `••••••${account.accountNumber.slice(-4)}` : null,
      totalPaid: Number(paid),
      lastSalary: lastPaid === null ? null : Number(lastPaid),
      createdAt: user.createdAt,
      ineligibleReason: ineligibleReason({
        kycStatus: user.kycStatus,
        accountStatus: account?.status ?? null,
        status: user.status,
      }),
    })),
    total: total!.n,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

async function findUser(ctx: Ctx, id: string) {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (!user) throw notFound('User');
  return user;
}

export async function userDetail(ctx: Ctx, admin: AdminRow, id: string, meta: RequestMeta) {
  const user = await findUser(ctx, id);
  const [account, walletList, beneficiaryList, rules, splits, cases] = await Promise.all([
    salaryAccountView(ctx, id),
    listWallets(ctx, id),
    listBeneficiaries(ctx, id),
    rulesOverview(ctx, user),
    listExecutions(ctx, id, 1, 20),
    ctx.db.select().from(kycCases).where(eq(kycCases.userId, id)).orderBy(desc(kycCases.createdAt)).limit(1),
  ]);
  await audit(ctx.db, {
    actor: { type: 'admin', id: admin.id },
    userId: id,
    action: 'admin.viewed_user',
    target: { type: 'user', id },
    meta,
  });
  const [row] = await ctx.db
    .select({ status: salaryAccounts.status })
    .from(salaryAccounts)
    .where(eq(salaryAccounts.userId, id));
  const profile = publicUser(user);
  const kyc = cases[0];
  return {
    profile: {
      ...profile,
      phone: profile.phone ? `${profile.phone.slice(0, 7)}•••${profile.phone.slice(-4)}` : null,
      emailVerified: user.emailVerifiedAt !== null,
    },
    kyc: kyc
      ? {
          identityType: kyc.identityType,
          identityMasked: `•••••••${kyc.identityLast4}`,
          identityStatus: kyc.identityStatus,
          identityCheckedAt: kyc.identityCheckedAt,
          livenessStatus: kyc.livenessStatus,
          livenessCheckedAt: kyc.livenessCheckedAt,
          livenessScore: kyc.livenessScore,
          matchScore: kyc.matchScore,
          inReview: kyc.status === 'pending_review',
          provider: kyc.provider,
          reason: kyc.reason,
        }
      : null,
    account,
    wallets: walletList,
    beneficiaries: beneficiaryList,
    rules: rules.rules,
    splits: splits.items,
    ineligibleReason: ineligibleReason({
      kycStatus: user.kycStatus,
      accountStatus: row?.status ?? null,
      status: user.status,
    }),
    suggestedPayCycle: await nextOpenCycle(ctx, user),
  };
}

export async function userTransactions(ctx: Ctx, id: string, filter: Parameters<typeof listTransactions>[2]) {
  return listTransactions(ctx, await findUser(ctx, id), filter);
}

/** First pay cycle, from the current one on, that has not been split automatically. */
async function nextOpenCycle(ctx: Ctx, user: typeof users.$inferSelect): Promise<string> {
  let cycle = payCycleFor(ctx.now(), user.salaryDay, user.timezone);
  const used = await ctx.db
    .select({ cycle: executions.payCycle })
    .from(executions)
    .where(and(eq(executions.userId, user.id), eq(executions.trigger, 'automatic')));
  const taken = new Set(used.map((u) => u.cycle));
  while (taken.has(cycle)) cycle = addCycles(cycle, 1);
  return cycle;
}

export async function salaryTransactions(
  ctx: Ctx,
  filter: {
    q?: string | undefined;
    userId?: string | undefined;
    splitState?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    page: number;
    pageSize: number;
  },
) {
  const where = and(
    ...([
      filter.userId ? eq(salaryPayments.userId, filter.userId) : undefined,
      filter.splitState ? eq(salaryPayments.splitState, filter.splitState) : undefined,
      filter.from ? gte(salaryPayments.paidAt, new Date(filter.from)) : undefined,
      filter.to ? lt(salaryPayments.paidAt, new Date(Date.parse(filter.to) + 86_400_000)) : undefined,
      filter.q
        ? or(
            ilike(salaryPayments.reference, like(filter.q)),
            ilike(salaryPayments.providerReference, like(filter.q)),
            ilike(users.email, like(filter.q)),
            ilike(sql`${users.firstName} || ' ' || ${users.lastName}`, like(filter.q)),
          )
        : undefined,
    ].filter(Boolean) as SQL[]),
  );
  const base = ctx.db
    .select({ payment: salaryPayments, user: users, execution: executions })
    .from(salaryPayments)
    .innerJoin(users, eq(users.id, salaryPayments.userId))
    .leftJoin(
      executions,
      and(eq(executions.salaryPaymentId, salaryPayments.id), eq(executions.trigger, 'automatic')),
    );
  const [rows, [total]] = await Promise.all([
    base
      .where(where)
      .orderBy(desc(salaryPayments.paidAt))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    ctx.db
      .select({ n: count() })
      .from(salaryPayments)
      .innerJoin(users, eq(users.id, salaryPayments.userId))
      .where(where),
  ]);
  return {
    items: rows.map(({ payment: p, user, execution }) => ({
      id: p.id,
      reference: p.reference,
      userId: user.id,
      userName: `${user.firstName} ${user.lastName}`,
      userEmail: user.email,
      amount: Number(p.amount),
      payCycle: p.payCycle,
      source: p.source,
      splitState: p.splitState,
      executionStatus: execution?.status ?? null,
      paidAt: p.paidAt,
    })),
    total: total!.n,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

export async function salaryTransactionDetail(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ payment: salaryPayments, user: users })
    .from(salaryPayments)
    .innerJoin(users, eq(users.id, salaryPayments.userId))
    .where(eq(salaryPayments.id, id));
  if (!row) throw notFound('Salary transaction');
  const runs = await ctx.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.salaryPaymentId, id))
    .orderBy(executions.createdAt);
  const p = row.payment;
  return {
    id: p.id,
    reference: p.reference,
    userId: row.user.id,
    userName: `${row.user.firstName} ${row.user.lastName}`,
    userEmail: row.user.email,
    amount: Number(p.amount),
    providerFee: Number(p.providerFee),
    provider: p.provider,
    providerReference: p.providerReference,
    channel: p.channel,
    source: p.source,
    payCycle: p.payCycle,
    splitState: p.splitState,
    paidAt: p.paidAt,
    confirmedAt: p.confirmedAt,
    executions: await Promise.all(runs.map((r) => executionDetail(ctx, r.id))),
  };
}

/**
 * Sends a test salary through the payment provider's sandbox. The salary is credited only when the provider
 * confirms it, through the same path a real one takes; this call never credits anything itself.
 */
export async function startPayIn(
  ctx: Ctx,
  admin: AdminRow,
  input: { userId: string; amount: number; payCycle?: string | undefined },
  meta: RequestMeta,
) {
  const user = await findUser(ctx, input.userId);
  const [account] = await ctx.db.select().from(salaryAccounts).where(eq(salaryAccounts.userId, user.id));
  const reason = ineligibleReason({
    kycStatus: user.kycStatus,
    accountStatus: account?.status ?? null,
    status: user.status,
  });
  if (reason)
    throw unprocessable(
      'user_not_eligible',
      `This user cannot receive a test salary: ${reason.toLowerCase()}`,
    );

  const [run] = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .insert(payinRuns)
      .values({
        adminId: admin.id,
        userId: user.id,
        amount: BigInt(input.amount),
        payCycle: input.payCycle ?? (await nextOpenCycle(ctx, user)),
        provider: ctx.payments.name,
        providerReference: `psi-${crypto.randomUUID()}`,
      })
      .returning();
    await audit(tx, {
      actor: { type: 'admin', id: admin.id },
      userId: user.id,
      action: 'admin.payin_started',
      target: { type: 'payin_run', id: rows[0]!.id },
      metadata: { amount: input.amount },
      meta,
    });
    return rows;
  });

  try {
    const result = await ctx.payments.submitTestPayIn({
      reference: run!.providerReference,
      amount: run!.amount,
      email: user.email,
      metadata: { purpose: 'paysplit_salary_test', payin_run_id: run!.id },
    });
    await ctx.db
      .update(payinRuns)
      .set(
        result.status === 'failed'
          ? { status: 'failed', failureReason: 'The provider declined the pay-in' }
          : { status: 'awaiting_confirmation' },
      )
      .where(and(eq(payinRuns.id, run!.id), sql`status <> 'confirmed'`));
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const definite = error.kind === 'rejected' || error.kind === 'not_found';
    await ctx.db
      .update(payinRuns)
      .set(
        definite
          ? { status: 'failed', failureReason: error.message.slice(0, 300) }
          : { status: 'awaiting_confirmation' },
      )
      .where(and(eq(payinRuns.id, run!.id), sql`status <> 'confirmed'`));
    if (definite)
      throw new AppError(502, 'provider_refused', `The provider refused the pay-in: ${error.message}`);
  }
  return payInRun(ctx, run!.id);
}

/** Asks the provider about a run still waiting, for when its webhook is late. */
export async function refreshPayIn(ctx: Ctx, id: string) {
  const [run] = await ctx.db.select().from(payinRuns).where(eq(payinRuns.id, id));
  if (!run) throw notFound('Pay-in');
  if (run.status === 'failed') throw conflict('payin_failed', 'This pay-in failed and cannot be refreshed');
  try {
    const paymentId = await creditPayIn(ctx, await ctx.payments.getPayIn(run.providerReference));
    if (paymentId)
      await enqueue(
        ctx.db,
        'split.automatic',
        { salaryPaymentId: paymentId },
        { dedupeKey: `split:${paymentId}` },
      );
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
  }
  return payInRun(ctx, id);
}

export async function listPayIns(
  ctx: Ctx,
  filter: { page: number; pageSize: number; userId?: string | undefined },
) {
  const where = filter.userId ? eq(payinRuns.userId, filter.userId) : undefined;
  const [rows, [total]] = await Promise.all([
    ctx.db
      .select({ run: payinRuns, user: users, admin: admins, payment: salaryPayments, execution: executions })
      .from(payinRuns)
      .innerJoin(users, eq(users.id, payinRuns.userId))
      .innerJoin(admins, eq(admins.id, payinRuns.adminId))
      .leftJoin(salaryPayments, eq(salaryPayments.payinRunId, payinRuns.id))
      .leftJoin(
        executions,
        and(eq(executions.salaryPaymentId, salaryPayments.id), eq(executions.trigger, 'automatic')),
      )
      .where(where)
      .orderBy(desc(payinRuns.createdAt))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    ctx.db.select({ n: count() }).from(payinRuns).where(where),
  ]);
  return {
    items: rows.map(({ run, user, admin, payment, execution }) => ({
      id: run.id,
      userId: user.id,
      userName: `${user.firstName} ${user.lastName}`,
      adminName: `${admin.firstName} ${admin.lastName}`,
      amount: Number(run.amount),
      confirmedAmount: payment ? Number(payment.amount) : null,
      payCycle: run.payCycle,
      status: run.status,
      splitState: payment?.splitState ?? null,
      executionStatus: execution?.status ?? null,
      providerReference: run.providerReference,
      failureReason: run.failureReason,
      createdAt: run.createdAt,
    })),
    total: total!.n,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

export async function payInRun(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ run: payinRuns, user: users, admin: admins, payment: salaryPayments })
    .from(payinRuns)
    .innerJoin(users, eq(users.id, payinRuns.userId))
    .innerJoin(admins, eq(admins.id, payinRuns.adminId))
    .leftJoin(salaryPayments, eq(salaryPayments.payinRunId, payinRuns.id))
    .where(eq(payinRuns.id, id));
  if (!row) throw notFound('Pay-in');
  const [execution] = row.payment
    ? await ctx.db
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.salaryPaymentId, row.payment.id), eq(executions.trigger, 'automatic')))
    : [];
  return {
    id: row.run.id,
    userId: row.user.id,
    userName: `${row.user.firstName} ${row.user.lastName}`,
    adminName: `${row.admin.firstName} ${row.admin.lastName}`,
    amount: Number(row.run.amount),
    confirmedAmount: row.payment ? Number(row.payment.amount) : null,
    payCycle: row.run.payCycle,
    status: row.run.status,
    failureReason: row.run.failureReason,
    provider: row.run.provider,
    providerReference: row.run.providerReference,
    salaryPaymentId: row.payment?.id ?? null,
    splitState: row.payment?.splitState ?? null,
    execution: execution ? await executionDetail(ctx, execution.id) : null,
    createdAt: row.run.createdAt,
  };
}

export async function listIssues(ctx: Ctx) {
  return ctx.db
    .select()
    .from(reconciliationIssues)
    .orderBy(sql`status = 'open' desc`, desc(reconciliationIssues.updatedAt))
    .limit(100);
}

export async function listAudit(
  ctx: Ctx,
  filter: { userId?: string | undefined; page: number; pageSize: number },
) {
  const where = filter.userId ? eq(auditLogs.userId, filter.userId) : undefined;
  const [rows, [total]] = await Promise.all([
    ctx.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    ctx.db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  return { items: rows, total: total!.n, page: filter.page, pageSize: filter.pageSize };
}
