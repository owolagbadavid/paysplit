import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { planSplit, totalBps, type RuleInput, type RuleUpdateInput } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import type { Executor } from '../db/client.ts';
import { allocations, beneficiaries, executions, rules, salaryPayments, wallets } from '../db/schema.ts';
import { conflict, notFound, unprocessable, uniqueViolation } from '../lib/errors.ts';
import { audit, type RequestMeta } from './audit.ts';
import { requireVerified } from './eligibility.ts';
import type { UserRow } from './sessions.ts';

type RuleRow = typeof rules.$inferSelect;

/** Rules with their destinations, in execution order. */
export async function loadRules(ex: Executor, userId: string, options: { activeOnly?: boolean } = {}) {
  return ex
    .select({ rule: rules, wallet: wallets, beneficiary: beneficiaries })
    .from(rules)
    .leftJoin(wallets, eq(wallets.id, rules.walletId))
    .leftJoin(beneficiaries, eq(beneficiaries.id, rules.beneficiaryId))
    .where(
      and(
        eq(rules.userId, userId),
        options.activeOnly ? eq(rules.status, 'active') : sql`${rules.status} <> 'deleted'`,
      ),
    )
    .orderBy(asc(rules.priority), asc(rules.createdAt), asc(rules.id));
}

export type LoadedRule = Awaited<ReturnType<typeof loadRules>>[number];

export function destinationOf(loaded: LoadedRule) {
  if (loaded.wallet) {
    return {
      type: 'wallet' as const,
      id: loaded.wallet.id,
      key: `wallet:${loaded.wallet.id}`,
      name: loaded.wallet.name,
      detail: 'Wallet',
      category: loaded.wallet.category,
      usable: loaded.wallet.status === 'active',
    };
  }
  const b = loaded.beneficiary!;
  return {
    type: 'beneficiary' as const,
    id: b.id,
    key: `account:${b.accountFingerprint}`,
    name: b.name,
    detail: `${b.bankName} ••••${b.accountLast4}`,
    category: b.category,
    usable: b.status === 'active',
  };
}

function ruleView(loaded: LoadedRule, user: UserRow) {
  const { rule } = loaded;
  const destination = destinationOf(loaded);
  return {
    id: rule.id,
    name: rule.name,
    method: rule.method,
    value: Number(rule.value),
    priority: rule.priority,
    status: rule.status,
    destination: {
      type: destination.type,
      id: destination.id,
      name: destination.name,
      detail: destination.detail,
      category: destination.category,
    },
    /** Why an active rule would not run right now, so it is never shown as fully working when it is not. */
    blockedReason:
      rule.status === 'active' && user.kycStatus !== 'approved'
        ? 'Verification is required before this rule can run'
        : null,
    activatedAt: rule.activatedAt,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

async function salaryBaseline(
  ctx: Ctx,
  user: UserRow,
): Promise<{ amount: bigint; source: 'last_salary' | 'expected' | null }> {
  const [last] = await ctx.db
    .select({ amount: salaryPayments.amount })
    .from(salaryPayments)
    .where(eq(salaryPayments.userId, user.id))
    .orderBy(desc(salaryPayments.paidAt))
    .limit(1);
  if (user.expectedSalary) return { amount: user.expectedSalary, source: 'expected' };
  if (last) return { amount: last.amount, source: 'last_salary' };
  return { amount: 0n, source: null };
}

/** All rules, plus what the active ones would do to the expected salary. */
export async function rulesOverview(ctx: Ctx, user: UserRow) {
  const loaded = await loadRules(ctx.db, user.id);
  const baseline = await salaryBaseline(ctx, user);
  const active = loaded.filter((l) => l.rule.status === 'active');
  const plan = planSplit({
    base: baseline.amount,
    available: baseline.amount,
    rules: active.map((l) => ({
      id: l.rule.id,
      destinationKey: destinationOf(l).key,
      method: l.rule.method,
      value: l.rule.value,
      priority: l.rule.priority,
      createdAt: l.rule.createdAt,
    })),
  });
  const monthStart = new Date(Date.UTC(ctx.now().getUTCFullYear(), ctx.now().getUTCMonth(), 1));
  const month = await ctx.db
    .select({ ruleId: allocations.ruleId, total: sql<string>`sum(${allocations.allocatedAmount})` })
    .from(allocations)
    .where(
      and(
        eq(allocations.userId, user.id),
        eq(allocations.status, 'success'),
        sql`${allocations.createdAt} >= ${monthStart.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(allocations.ruleId);
  const monthByRule = new Map(month.map((m) => [m.ruleId, Number(m.total)]));
  return {
    baseline: { amount: Number(baseline.amount), source: baseline.source },
    projection: {
      totalAllocated: Number(plan.totalAllocated),
      remainder: Number(plan.remainder),
      allocations: plan.allocations.map((a) => ({
        ruleId: a.ruleId,
        requested: Number(a.requested),
        allocated: Number(a.allocated),
        skipReason: a.skipReason ?? null,
      })),
    },
    rules: loaded.map((l) => ({ ...ruleView(l, user), allocatedThisMonth: monthByRule.get(l.rule.id) ?? 0 })),
  };
}

export async function ruleDetail(ctx: Ctx, user: UserRow, ruleId: string) {
  const loaded = (await loadRules(ctx.db, user.id)).find((l) => l.rule.id === ruleId);
  if (!loaded) throw notFound('Rule');
  const history = await ctx.db
    .select({ allocation: allocations, execution: executions })
    .from(allocations)
    .innerJoin(executions, eq(executions.id, allocations.executionId))
    .where(eq(allocations.ruleId, ruleId))
    .orderBy(desc(allocations.createdAt))
    .limit(50);
  return {
    ...ruleView(loaded, user),
    history: history.map(({ allocation: a, execution: e }) => ({
      executionId: e.id,
      executionReference: e.reference,
      trigger: e.trigger,
      requested: Number(a.requestedAmount),
      allocated: Number(a.allocatedAmount),
      status: a.status,
      skipReason: a.skipReason,
      createdAt: a.createdAt,
    })),
  };
}

async function ownRule(ex: Executor, userId: string, ruleId: string): Promise<RuleRow> {
  const [rule] = await ex
    .select()
    .from(rules)
    .where(and(eq(rules.id, ruleId), eq(rules.userId, userId), sql`status <> 'deleted'`));
  if (!rule) throw notFound('Rule');
  return rule;
}

/** Refuses percentages that could never all be funded, however large the salary. */
async function assertPercentagesFit(
  ex: Executor,
  userId: string,
  candidate: { id?: string; method: 'fixed' | 'percentage'; value: bigint },
) {
  if (candidate.method !== 'percentage') return;
  const active = await ex
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.status, 'active')));
  const total = totalBps([...active.filter((r) => r.id !== candidate.id), candidate]);
  if (total > 10_000) {
    throw unprocessable(
      'over_allocated',
      `Your active percentages would add up to ${total / 100}%. Keep them at 100% or below.`,
    );
  }
}

async function destinationExists(ctx: Ctx, userId: string, type: 'wallet' | 'beneficiary', id: string) {
  const [row] =
    type === 'wallet'
      ? await ctx.db
          .select({ id: wallets.id })
          .from(wallets)
          .where(and(eq(wallets.id, id), eq(wallets.userId, userId), eq(wallets.status, 'active')))
      : await ctx.db
          .select({ id: beneficiaries.id })
          .from(beneficiaries)
          .where(
            and(
              eq(beneficiaries.id, id),
              eq(beneficiaries.userId, userId),
              eq(beneficiaries.status, 'active'),
            ),
          );
  if (!row) throw notFound(type === 'wallet' ? 'Wallet' : 'Beneficiary');
}

/** Saves a draft. Nothing runs until the owner reviews and activates it. */
export async function createRule(ctx: Ctx, user: UserRow, input: RuleInput, meta: RequestMeta) {
  await destinationExists(ctx, user.id, input.destinationType, input.destinationId);
  const column = input.destinationType === 'wallet' ? 'walletId' : 'beneficiaryId';
  try {
    const id = await ctx.db.transaction(async (tx) => {
      const [rule] = await tx
        .insert(rules)
        .values({
          userId: user.id,
          name: input.name,
          method: input.method,
          value: BigInt(input.value),
          priority: input.priority,
          [column]: input.destinationId,
        })
        .returning();
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'rule.created',
        target: { type: 'rule', id: rule!.id },
        meta,
      });
      return rule!.id;
    });
    return ruleDetail(ctx, user, id);
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const [existing] = await ctx.db
      .select({ id: rules.id })
      .from(rules)
      .where(and(eq(rules[column], input.destinationId), sql`status <> 'deleted'`));
    throw conflict('rule_exists', 'This destination already has a rule. Edit that one instead.', {
      ruleId: existing?.id,
    });
  }
}

export async function updateRule(
  ctx: Ctx,
  user: UserRow,
  ruleId: string,
  input: RuleUpdateInput,
  meta: RequestMeta,
) {
  await ctx.db.transaction(async (tx) => {
    const rule = await ownRule(tx, user.id, ruleId);
    if (rule.status === 'active')
      await assertPercentagesFit(tx, user.id, {
        id: ruleId,
        method: input.method,
        value: BigInt(input.value),
      });
    await tx
      .update(rules)
      .set({ name: input.name, method: input.method, value: BigInt(input.value), priority: input.priority })
      .where(eq(rules.id, ruleId));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'rule.updated',
      target: { type: 'rule', id: ruleId },
      metadata: {
        before: { method: rule.method, value: Number(rule.value), priority: rule.priority },
        after: { method: input.method, value: input.value, priority: input.priority },
      },
      meta,
    });
  });
  return ruleDetail(ctx, user, ruleId);
}

export async function setRuleStatus(
  ctx: Ctx,
  user: UserRow,
  ruleId: string,
  action: 'activate' | 'pause' | 'resume' | 'delete',
  meta: RequestMeta,
) {
  await ctx.db.transaction(async (tx) => {
    const rule = await ownRule(tx, user.id, ruleId);
    const allowed = {
      activate: ['draft'],
      pause: ['active'],
      resume: ['paused'],
      delete: ['draft', 'active', 'paused'],
    }[action];
    if (!allowed.includes(rule.status))
      throw conflict(
        'invalid_status',
        `A ${rule.status} rule cannot be ${action === 'activate' ? 'activated' : `${action}d`}`,
      );
    if (action === 'activate' || action === 'resume') {
      requireVerified(user);
      await assertPercentagesFit(tx, user.id, rule);
    }
    const set = {
      activate: { status: 'active', activatedAt: ctx.now() },
      resume: { status: 'active' },
      pause: { status: 'paused' },
      delete: { status: 'deleted', deletedAt: ctx.now() },
    }[action];
    await tx.update(rules).set(set).where(eq(rules.id, ruleId));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: `rule.${action}`,
      target: { type: 'rule', id: ruleId },
      meta,
    });
  });
}
