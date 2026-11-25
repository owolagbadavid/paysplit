import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  addCycles,
  cycleKey,
  dayNumber,
  expectedDateIn,
  isoDate,
  localDate,
  nextExpectedDate,
  payCycleFor,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { beneficiaries, executions, rules, salaryPayments, transactions, wallets } from '../db/schema.ts';
import type { UserRow } from './sessions.ts';
import { listExecutions, previewRunNow } from './splits.ts';
import { transactionView } from './transactions.ts';
import { listWallets, salaryAccountView } from './wallets.ts';

const MONTHS = 9;

/** Everything on the dashboard, from the same ledger and transaction records the rest of the product reads. */
export async function dashboard(ctx: Ctx, user: UserRow) {
  const now = ctx.now();
  const today = localDate(now, user.timezone);
  const firstMonth = new Date(Date.UTC(today.year, today.month - MONTHS, 1));

  const [account, walletList, splits, runNow, recent, payments, [counts], flow] = await Promise.all([
    salaryAccountView(ctx, user.id),
    listWallets(ctx, user.id),
    listExecutions(ctx, user.id, 1, 5),
    user.kycStatus === 'approved' ? previewRunNow(ctx, user) : [],
    ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, user.id))
      .orderBy(desc(transactions.createdAt))
      .limit(8),
    ctx.db
      .select()
      .from(salaryPayments)
      .where(eq(salaryPayments.userId, user.id))
      .orderBy(desc(salaryPayments.paidAt))
      .limit(3),
    ctx.db
      .select({
        activeRules: sql<number>`(select count(*)::int from ${rules} where user_id = ${user.id} and status = 'active')`,
        anyRules: sql<number>`(select count(*)::int from ${rules} where user_id = ${user.id} and status <> 'deleted')`,
        wallets: sql<number>`(select count(*)::int from ${wallets} where user_id = ${user.id} and status = 'active')`,
        beneficiaries: sql<number>`(select count(*)::int from ${beneficiaries} where user_id = ${user.id} and status = 'active')`,
        executions: sql<number>`(select count(*)::int from ${executions} where user_id = ${user.id})`,
      })
      .from(sql`(select 1) as one`),
    ctx.db
      .select({
        month: sql<string>`to_char(${transactions.createdAt} at time zone ${user.timezone}, 'YYYY-MM')`,
        salary: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'salary_received'), 0)`,
        wallets: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'wallet_allocation'), 0)`,
        beneficiaries: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'beneficiary_transfer'), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, user.id),
          eq(transactions.status, 'success'),
          gte(transactions.createdAt, firstMonth),
        ),
      )
      .groupBy(sql`1`),
  ]);

  const byMonth = new Map(flow.map((f) => [f.month, f]));
  const months = Array.from({ length: MONTHS }, (_, i) => {
    const date = new Date(Date.UTC(today.year, today.month - MONTHS + i, 1));
    const key = date.toISOString().slice(0, 7);
    const f = byMonth.get(key);
    return {
      month: key,
      salary: Number(f?.salary ?? 0),
      wallets: Number(f?.wallets ?? 0),
      beneficiaries: Number(f?.beneficiaries ?? 0),
    };
  });

  const lastSalary = payments[0];
  const lastSplits = lastSalary ? splits.items.filter((s) => s.salaryPaymentId === lastSalary.id) : [];
  const partition = lastSalary
    ? {
        salary: Number(lastSalary.amount),
        payCycle: lastSalary.payCycle,
        wallets: lastSplits.reduce((sum, s) => sum + s.toWallets, 0),
        beneficiaries: lastSplits.reduce((sum, s) => sum + s.toBeneficiaries, 0),
        pending: lastSplits.reduce((sum, s) => sum + s.pending, 0),
      }
    : null;
  const thisMonth = months.at(-1)!;

  const paidCycles = new Set(payments.map((p) => p.payCycle));
  let expected = user.salaryDay ? nextExpectedDate(user.salaryDay, now, user.timezone) : null;
  // A salary that came early already covers this cycle, so the next one is a month later.
  while (expected && paidCycles.has(cycleKey(expected.year, expected.month))) {
    const [year, month] = addCycles(cycleKey(expected.year, expected.month), 1).split('-').map(Number) as [
      number,
      number,
    ];
    expected = expectedDateIn(year, month, user.salaryDay!);
  }
  const currentCycle = payCycleFor(now, user.salaryDay, user.timezone);
  const receivedThisCycle = paidCycles.has(currentCycle);
  const [cycleYear, cycleMonth] = currentCycle.split('-').map(Number) as [number, number];
  const overdue =
    user.salaryDay !== null &&
    dayNumber(expectedDateIn(cycleYear, cycleMonth, user.salaryDay)) < dayNumber(today);

  const setup = {
    emailVerified: user.emailVerifiedAt !== null,
    profile: Boolean(user.country && user.phone),
    kyc: user.kycStatus === 'approved',
    income: user.salaryDay !== null,
    destination: counts!.wallets + counts!.beneficiaries > 0,
    rule: counts!.anyRules > 0,
  };
  const done = Object.values(setup).filter(Boolean).length;

  return {
    account,
    period: {
      month: thisMonth.month,
      salaryReceived: thisMonth.salary,
      allocated: thisMonth.wallets + thisMonth.beneficiaries,
    },
    walletTotal: walletList.reduce((sum, w) => sum + w.balance, 0),
    wallets: walletList,
    targetWallets: walletList.filter((w) => w.targetAmount).length,
    activeRules: counts!.activeRules,
    expected: expected
      ? {
          date: isoDate(expected),
          /** The latest due date has passed and nothing arrived for that cycle. */
          awaited: overdue && !receivedThisCycle && account?.status === 'active',
        }
      : null,
    months,
    partition: partition && {
      ...partition,
      remaining: partition.salary - partition.wallets - partition.beneficiaries - partition.pending,
    },
    recentSplits: splits.items,
    recentTransactions: recent.map(transactionView),
    runNowAvailable: runNow.some((option) => option.totalAllocated > 0),
    setup: { ...setup, percent: Math.round((done / Object.keys(setup).length) * 100) },
    setupSkipped: user.setupSkippedAt !== null,
  };
}
