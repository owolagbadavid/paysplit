import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  executionStatus,
  formatMoney,
  planSplit,
  SKIP_REASON_TEXT,
  TIER_LIMITS,
  type SplitPlan,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import type { Executor, Tx } from '../db/client.ts';
import {
  allocations,
  executions,
  salaryAccounts,
  salaryPayments,
  transactions,
  transferAttempts,
  transfers,
  users,
} from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { reference } from '../lib/ids.ts';
import { audit, type RequestMeta } from './audit.ts';
import { requireVerified } from './eligibility.ts';
import { withIdempotency } from './idempotency.ts';
import { enqueue } from './jobs.ts';
import { balanceOf, credit, debit, PLATFORM, platformAccount, post } from './ledger.ts';
import { notify } from './notifications.ts';
import { destinationOf, loadRules, type LoadedRule } from './rules.ts';
import { lockSalaryAccount } from './salary-accounts.ts';
import type { UserRow } from './sessions.ts';

type PaymentRow = typeof salaryPayments.$inferSelect;
type ExecutionRow = typeof executions.$inferSelect;

/** Funds from one salary that are neither allocated nor committed to a transfer still in flight. */
async function unallocated(ex: Executor, payment: PaymentRow) {
  const taken = await ex
    .select({ key: allocations.destinationKey, amount: allocations.allocatedAmount })
    .from(allocations)
    .where(
      and(eq(allocations.salaryPaymentId, payment.id), inArray(allocations.status, ['pending', 'success'])),
    );
  const total = taken.reduce((sum, t) => sum + t.amount, 0n);
  return { amount: payment.amount - total, destinations: new Set(taken.map((t) => t.key)) };
}

async function transferBudget(ctx: Ctx, ex: Executor, userId: string): Promise<bigint> {
  const since = new Date(ctx.now().getTime() - 86_400_000);
  const [row] = await ex
    .select({ total: sql<string>`coalesce(sum(${transfers.amount}), 0)` })
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        gte(transfers.createdAt, since),
        sql`${transfers.status} not in ('failed','reversed')`,
      ),
    );
  const left = TIER_LIMITS.verified.dailyTransfer - BigInt(row!.total);
  return left > 0n ? left : 0n;
}

/** Plans a split of one salary payment against the rules that have not been funded from it yet. */
async function planFor(ctx: Ctx, ex: Executor, payment: PaymentRow, salaryLedgerId: string) {
  const loaded = await loadRules(ex, payment.userId, { activeOnly: true });
  const { amount, destinations } = await unallocated(ex, payment);
  const balance = await balanceOf(ex, salaryLedgerId);
  const available = amount < balance ? amount : balance;
  const open = loaded.filter((l) => !destinations.has(destinationOf(l).key));
  const plan = planSplit({
    base: payment.amount,
    available,
    transferBudget: await transferBudget(ctx, ex, payment.userId),
    rules: open.map((l) => {
      const destination = destinationOf(l);
      const external = destination.type === 'beneficiary';
      return {
        id: l.rule.id,
        destinationKey: destination.key,
        method: l.rule.method,
        value: l.rule.value,
        priority: l.rule.priority,
        createdAt: l.rule.createdAt,
        external,
        ...(external ? { maxAmount: TIER_LIMITS.verified.singleTransfer } : {}),
        ...(destination.usable ? {} : { blocked: 'destination_unavailable' as const }),
      };
    }),
  });
  return { plan, loaded: open };
}

function hashPlan(paymentId: string, plan: SplitPlan): string {
  return sha256(
    JSON.stringify([
      paymentId,
      plan.available.toString(),
      plan.allocations.map((a) => [
        a.ruleId,
        a.requested.toString(),
        a.allocated.toString(),
        a.skipReason ?? '',
      ]),
    ]),
  );
}

/**
 * Turns a plan into records and ledger movements, all in the caller's transaction. Wallet allocations settle at
 * once. Beneficiary allocations move to clearing, so the money is committed, and a job sends the transfer after
 * commit.
 */
async function execute(
  ctx: Ctx,
  tx: Tx,
  input: {
    payment: PaymentRow;
    plan: SplitPlan;
    loaded: LoadedRule[];
    trigger: 'automatic' | 'manual';
    salaryLedgerId: string;
    salaryLast4: string;
  },
): Promise<ExecutionRow> {
  const { payment, plan, trigger } = input;
  const byId = new Map(input.loaded.map((l) => [l.rule.id, l]));
  const initial = plan.allocations.map((a) => {
    if (a.outcome === 'skip') return 'skipped' as const;
    return destinationOf(byId.get(a.ruleId)!).type === 'wallet' ? ('success' as const) : ('pending' as const);
  });
  const status = executionStatus(initial);

  const [execution] = await tx
    .insert(executions)
    .values({
      reference: reference('SPL', ctx.now()),
      userId: payment.userId,
      salaryPaymentId: payment.id,
      trigger,
      payCycle: payment.payCycle,
      status,
      baseAmount: plan.base,
      availableAmount: plan.available,
      completedAt: status === 'pending' ? null : ctx.now(),
    })
    .returning();
  const clearing = await platformAccount(tx, PLATFORM.clearing);

  for (const [index, planned] of plan.allocations.entries()) {
    const loaded = byId.get(planned.ruleId)!;
    const { rule } = loaded;
    const destination = destinationOf(loaded);
    const [allocation] = await tx
      .insert(allocations)
      .values({
        executionId: execution!.id,
        salaryPaymentId: payment.id,
        userId: payment.userId,
        ruleId: rule.id,
        walletId: rule.walletId,
        beneficiaryId: rule.beneficiaryId,
        destinationKey: destination.key,
        position: planned.position,
        snapshot: {
          name: rule.name,
          method: rule.method,
          value: Number(rule.value),
          priority: rule.priority,
          destinationType: destination.type,
          destinationName: destination.name,
          destinationDetail: destination.detail,
          category: destination.category,
        },
        requestedAmount: planned.requested,
        allocatedAmount: planned.allocated,
        availableBefore: planned.availableBefore,
        status: initial[index]!,
        skipReason: planned.skipReason ?? null,
      })
      .returning();
    if (planned.outcome === 'skip') continue;

    const external = destination.type === 'beneficiary';
    const [transaction] = await tx
      .insert(transactions)
      .values({
        reference: reference('PAY', ctx.now()),
        userId: payment.userId,
        type: external ? 'beneficiary_transfer' : 'wallet_allocation',
        status: external ? 'pending' : 'success',
        amount: planned.allocated,
        description: external ? `Transfer to ${destination.name}` : `Split to ${destination.name}`,
        category: destination.category,
        source: { label: 'Salary account', detail: input.salaryLast4 },
        destination: { label: destination.name, detail: destination.detail },
        walletId: rule.walletId,
        beneficiaryId: rule.beneficiaryId,
        ruleId: rule.id,
        executionId: execution!.id,
        allocationId: allocation!.id,
        salaryPaymentId: payment.id,
        completedAt: external ? null : ctx.now(),
      })
      .returning();

    await post(tx, {
      reference: `${external ? 'hold' : 'allocation'}:${allocation!.id}`,
      type: external ? 'transfer_hold' : 'wallet_allocation',
      description: transaction!.description,
      transactionId: transaction!.id,
      postings: [
        debit(input.salaryLedgerId, planned.allocated),
        credit(external ? clearing : loaded.wallet!.ledgerAccountId, planned.allocated),
      ],
    });
    if (external) {
      const [transfer] = await tx
        .insert(transfers)
        .values({
          allocationId: allocation!.id,
          transactionId: transaction!.id,
          userId: payment.userId,
          beneficiaryId: loaded.beneficiary!.id,
          recipientCode: loaded.beneficiary!.recipientCode,
          narration: (loaded.beneficiary!.narration || `PaySplit ${transaction!.reference}`).slice(0, 80),
          amount: planned.allocated,
        })
        .returning();
      await enqueue(
        tx,
        'transfer.process',
        { transferId: transfer!.id },
        { dedupeKey: `transfer:${transfer!.id}`, maxAttempts: 30 },
      );
    }
  }

  await tx.update(salaryPayments).set({ splitState: 'split' }).where(eq(salaryPayments.id, payment.id));
  await audit(tx, {
    actor: trigger === 'manual' ? { type: 'user', id: payment.userId } : { type: 'system' },
    userId: payment.userId,
    action: `split.${trigger}`,
    target: { type: 'execution', id: execution!.id },
    metadata: {
      base: Number(plan.base),
      allocated: Number(plan.totalAllocated),
      remainder: Number(plan.remainder),
    },
  });
  if (status !== 'pending') await announce(ctx, tx, execution!, status);
  return execution!;
}

const HOLD_NOTICES = {
  held: {
    title: 'Another payment arrived this cycle',
    body: 'Your automatic split already ran for this pay cycle, so this payment was left in your salary account. Use Run Now if you want to split it.',
  },
  no_rules: {
    title: 'No active split rules',
    body: 'Your salary stayed in your salary account because you have no active rules. Add one and use Run Now.',
  },
  not_eligible: {
    title: 'Split paused',
    body: 'Your salary was not split because your verification is incomplete.',
  },
} as const;

async function leaveUnsplit(
  ctx: Ctx,
  tx: Tx,
  payment: PaymentRow,
  state: keyof typeof HOLD_NOTICES,
): Promise<void> {
  if (payment.splitState === state) return;
  await tx.update(salaryPayments).set({ splitState: state }).where(eq(salaryPayments.id, payment.id));
  await notify(tx, {
    userId: payment.userId,
    type: `split_${state}`,
    dedupeKey: `split-${state}:${payment.id}`,
    severity: 'warning',
    ...HOLD_NOTICES[state],
    link: '/rules',
    email: {
      pref: 'split_executed',
      content: {
        subject: HOLD_NOTICES[state].title,
        paragraphs: [HOLD_NOTICES[state].body],
        button: { label: 'Open PaySplit', url: `${ctx.config.APP_URL}/rules` },
      },
    },
  });
}

/**
 * Splits a confirmed salary once. The payment is locked, its state is checked again under the lock, and unique
 * indexes allow one automatic execution per payment and per pay cycle, so any number of calls splits it once.
 */
export async function runAutomaticSplit(ctx: Ctx, salaryPaymentId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ userId: salaryPayments.userId })
      .from(salaryPayments)
      .where(eq(salaryPayments.id, salaryPaymentId));
    if (!found) throw notFound('Salary payment');
    const account = await lockSalaryAccount(tx, found.userId);
    const [payment] = await tx
      .select()
      .from(salaryPayments)
      .where(eq(salaryPayments.id, salaryPaymentId))
      .for('update');
    if (!account || !payment || !['awaiting', 'not_eligible'].includes(payment.splitState)) return;

    const [user] = await tx.select().from(users).where(eq(users.id, payment.userId));
    if (user!.status !== 'active' || user!.kycStatus !== 'approved')
      return leaveUnsplit(ctx, tx, payment, 'not_eligible');

    const [already] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.userId, payment.userId),
          eq(executions.payCycle, payment.payCycle),
          eq(executions.trigger, 'automatic'),
        ),
      );
    if (already) return leaveUnsplit(ctx, tx, payment, 'held');

    const { plan, loaded } = await planFor(ctx, tx, payment, account.ledgerAccountId);
    if (loaded.length === 0) return leaveUnsplit(ctx, tx, payment, 'no_rules');
    await execute(ctx, tx, {
      payment,
      plan,
      loaded,
      trigger: 'automatic',
      salaryLedgerId: account.ledgerAccountId,
      salaryLast4: `••••${account.accountNumber?.slice(-4) ?? ''}`,
    });
  });
}

/** Recomputes an execution after one of its transfers settles, and announces it once everything has. */
export async function refreshExecution(ctx: Ctx, tx: Tx, executionId: string): Promise<void> {
  const [execution] = await tx.select().from(executions).where(eq(executions.id, executionId)).for('update');
  const rows = await tx
    .select({ status: allocations.status })
    .from(allocations)
    .where(eq(allocations.executionId, executionId));
  const status = executionStatus(rows.map((r) => r.status));
  if (!execution || execution.status === status) return;
  await tx
    .update(executions)
    .set({ status, completedAt: status === 'pending' ? null : ctx.now() })
    .where(eq(executions.id, executionId));
  if (status !== 'pending') await announce(ctx, tx, execution, status);
}

async function announce(ctx: Ctx, tx: Tx, execution: ExecutionRow, status: string): Promise<void> {
  const rows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.executionId, execution.id))
    .orderBy(allocations.position);
  const moved = rows.filter((r) => r.status === 'success').reduce((sum, r) => sum + r.allocatedAmount, 0n);
  const short = rows.some((r) => r.skipReason === 'insufficient_funds');
  const title =
    status === 'successful'
      ? 'Split completed'
      : status === 'partially_completed'
        ? short
          ? 'Split partly completed: insufficient funds'
          : 'Split partly completed'
        : short
          ? 'Split failed: insufficient funds'
          : 'Split failed';
  await notify(tx, {
    userId: execution.userId,
    type: 'split_executed',
    dedupeKey: `execution:${execution.id}:${status}`,
    severity: status === 'successful' ? 'success' : status === 'failed' ? 'error' : 'warning',
    title,
    body: `${formatMoney(moved)} of ${formatMoney(execution.baseAmount)} was allocated.`,
    link: `/splits/${execution.id}`,
    email: {
      pref: 'split_executed',
      content: {
        subject: title,
        paragraphs: [
          `${formatMoney(moved)} of your ${formatMoney(execution.baseAmount)} salary was allocated.`,
        ],
        rows: rows.map((r): [string, string] => [
          r.snapshot.destinationName,
          r.status === 'success'
            ? formatMoney(r.allocatedAmount)
            : r.status === 'skipped'
              ? (SKIP_REASON_TEXT[r.skipReason ?? ''] ?? 'Skipped')
              : 'Failed, money returned',
        ]),
        button: { label: 'See the breakdown', url: `${ctx.config.APP_URL}/splits/${execution.id}` },
      },
    },
  });
}

async function runNowPlan(ctx: Ctx, ex: Executor, userId: string, salaryPaymentId?: string) {
  const [account] = await ex.select().from(salaryAccounts).where(eq(salaryAccounts.userId, userId));
  if (!account) return null;
  const payments = await ex
    .select()
    .from(salaryPayments)
    .where(
      and(
        eq(salaryPayments.userId, userId),
        salaryPaymentId ? eq(salaryPayments.id, salaryPaymentId) : undefined,
      ),
    )
    .orderBy(desc(salaryPayments.paidAt))
    .limit(6);
  const options = [];
  for (const payment of payments) {
    const { plan, loaded } = await planFor(ctx, ex, payment, account.ledgerAccountId);
    if (plan.available > 0n && loaded.length > 0) options.push({ payment, plan, loaded });
  }
  return { account, options };
}

/** What Run Now would do for each salary that still has unallocated money, newest first. Moves nothing. */
export async function previewRunNow(ctx: Ctx, user: UserRow) {
  const found = await runNowPlan(ctx, ctx.db, user.id);
  return (found?.options ?? []).map(({ payment, plan, loaded }) => {
    const byId = new Map(loaded.map((l) => [l.rule.id, l]));
    return {
      salaryPaymentId: payment.id,
      reference: payment.reference,
      paidAt: payment.paidAt,
      payCycle: payment.payCycle,
      salaryAmount: Number(payment.amount),
      available: Number(plan.available),
      totalAllocated: Number(plan.totalAllocated),
      remainder: Number(plan.remainder),
      planHash: hashPlan(payment.id, plan),
      allocations: plan.allocations.map((a) => {
        const l = byId.get(a.ruleId)!;
        const destination = destinationOf(l);
        return {
          ruleId: a.ruleId,
          ruleName: l.rule.name,
          method: l.rule.method,
          value: Number(l.rule.value),
          priority: l.rule.priority,
          destination: { type: destination.type, name: destination.name, detail: destination.detail },
          requested: Number(a.requested),
          allocated: Number(a.allocated),
          skipReason: a.skipReason ?? null,
        };
      }),
    };
  });
}

/**
 * Runs the rules a salary has not funded yet. Every rule reaches its destination at most once per salary, so this
 * can finish a split that was short or failed but can never repeat one.
 */
export async function runNow(
  ctx: Ctx,
  user: UserRow,
  input: { salaryPaymentId: string; planHash: string },
  idempotencyKey: string,
  meta: RequestMeta,
) {
  requireVerified(user);
  return ctx.db.transaction((tx) =>
    withIdempotency(tx, user.id, idempotencyKey, input, async () => {
      await lockSalaryAccount(tx, user.id);
      const [fresh] = await tx.select().from(users).where(eq(users.id, user.id));
      requireVerified(fresh!);
      const found = await runNowPlan(ctx, tx, user.id, input.salaryPaymentId);
      const option = found?.options[0];
      if (!found || !option)
        throw unprocessable('nothing_to_split', 'There is nothing left to split from this salary');
      if (hashPlan(option.payment.id, option.plan) !== input.planHash) {
        throw conflict(
          'plan_changed',
          'Your rules or balance changed since you reviewed this. Review it again.',
        );
      }
      if (option.plan.totalAllocated === 0n)
        throw unprocessable('nothing_to_split', 'None of your remaining rules can be funded right now');
      const execution = await execute(ctx, tx, {
        payment: option.payment,
        plan: option.plan,
        loaded: option.loaded,
        trigger: 'manual',
        salaryLedgerId: found.account.ledgerAccountId,
        salaryLast4: `••••${found.account.accountNumber?.slice(-4) ?? ''}`,
      });
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'split.run_now',
        target: { type: 'execution', id: execution.id },
        meta,
      });
      return { executionId: execution.id, reference: execution.reference, status: execution.status };
    }),
  );
}

async function totalsFor(ex: Executor, executionIds: string[]) {
  if (executionIds.length === 0)
    return new Map<
      string,
      { wallets: number; beneficiaries: number; pending: number; skipped: number; failed: number }
    >();
  const rows = await ex
    .select({
      executionId: allocations.executionId,
      wallets: sql<string>`coalesce(sum(${allocations.allocatedAmount}) filter (where ${allocations.status} = 'success' and ${allocations.walletId} is not null), 0)`,
      beneficiaries: sql<string>`coalesce(sum(${allocations.allocatedAmount}) filter (where ${allocations.status} = 'success' and ${allocations.beneficiaryId} is not null), 0)`,
      pending: sql<string>`coalesce(sum(${allocations.allocatedAmount}) filter (where ${allocations.status} = 'pending'), 0)`,
      skipped: sql<string>`count(*) filter (where ${allocations.status} = 'skipped')`,
      failed: sql<string>`count(*) filter (where ${allocations.status} in ('failed','reversed'))`,
    })
    .from(allocations)
    .where(inArray(allocations.executionId, executionIds))
    .groupBy(allocations.executionId);
  return new Map(
    rows.map((r) => [
      r.executionId,
      {
        wallets: Number(r.wallets),
        beneficiaries: Number(r.beneficiaries),
        pending: Number(r.pending),
        skipped: Number(r.skipped),
        failed: Number(r.failed),
      },
    ]),
  );
}

function executionView(
  execution: ExecutionRow,
  totals:
    { wallets: number; beneficiaries: number; pending: number; skipped: number; failed: number } | undefined,
) {
  const t = totals ?? { wallets: 0, beneficiaries: 0, pending: 0, skipped: 0, failed: 0 };
  return {
    id: execution.id,
    reference: execution.reference,
    salaryPaymentId: execution.salaryPaymentId,
    trigger: execution.trigger,
    payCycle: execution.payCycle,
    status: execution.status,
    salaryAmount: Number(execution.baseAmount),
    availableAmount: Number(execution.availableAmount),
    toWallets: t.wallets,
    toBeneficiaries: t.beneficiaries,
    pending: t.pending,
    skippedCount: t.skipped,
    failedCount: t.failed,
    remaining: Number(execution.availableAmount) - t.wallets - t.beneficiaries - t.pending,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt,
  };
}

export async function listExecutions(ctx: Ctx, userId: string, page: number, pageSize: number) {
  const mine = eq(executions.userId, userId);
  const [rows, [total]] = await Promise.all([
    ctx.db
      .select()
      .from(executions)
      .where(mine)
      .orderBy(desc(executions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db.select({ n: count() }).from(executions).where(mine),
  ]);
  const totals = await totalsFor(
    ctx.db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => executionView(r, totals.get(r.id))), total: total!.n, page, pageSize };
}

export async function executionDetail(ctx: Ctx, executionId: string, userId?: string) {
  const [execution] = await ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.id, executionId), userId ? eq(executions.userId, userId) : undefined));
  if (!execution) throw notFound('Split');
  const totals = await totalsFor(ctx.db, [executionId]);
  const rows = await ctx.db
    .select({ allocation: allocations, transaction: transactions, transfer: transfers })
    .from(allocations)
    .leftJoin(transactions, eq(transactions.allocationId, allocations.id))
    .leftJoin(transfers, eq(transfers.allocationId, allocations.id))
    .where(eq(allocations.executionId, executionId))
    .orderBy(allocations.position);
  const [payment] = await ctx.db
    .select()
    .from(salaryPayments)
    .where(eq(salaryPayments.id, execution.salaryPaymentId));
  return {
    ...executionView(execution, totals.get(executionId)),
    salaryReference: payment!.reference,
    allocations: rows.map(({ allocation: a, transaction: t, transfer }) => ({
      id: a.id,
      ruleId: a.ruleId,
      rule: a.snapshot,
      requested: Number(a.requestedAmount),
      allocated: Number(a.allocatedAmount),
      availableBefore: Number(a.availableBefore),
      status: t && t.status === 'retrying' ? 'retrying' : a.status,
      skipReason: a.skipReason,
      failureReason: a.failureReason,
      attempts: transfer?.attemptCount ?? 0,
      transactionId: t?.id ?? null,
      transactionReference: t?.reference ?? null,
    })),
  };
}

export type ExecutionDetail = Awaited<ReturnType<typeof executionDetail>>;

/** Attempts behind one transfer, for administrators tracing a payment. */
export async function transferAttemptsFor(ctx: Ctx, transactionId: string) {
  const rows = await ctx.db
    .select({ attempt: transferAttempts })
    .from(transferAttempts)
    .innerJoin(transfers, eq(transfers.id, transferAttempts.transferId))
    .where(eq(transfers.transactionId, transactionId))
    .orderBy(transferAttempts.attemptNo);
  return rows.map(({ attempt: a }) => ({
    no: a.attemptNo,
    reference: a.reference,
    status: a.status,
    reason: a.failureReason,
    createdAt: a.createdAt,
  }));
}
