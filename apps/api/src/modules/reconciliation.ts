import { and, eq, inArray, sql } from 'drizzle-orm';
import { formatMoney } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { ledgerAccounts, payinRuns, salaryPayments } from '../db/schema.ts';
import { ProviderError } from '../lib/errors.ts';
import { raiseIssue, resolveIssue } from './issues.ts';
import { PLATFORM } from './ledger.ts';
import { creditPayIn } from './salary-payments.ts';

/** Finds salaries the provider confirmed whose webhook never reached us, and credits them. */
export async function recoverPayIns(ctx: Ctx, lookbackHours = 72): Promise<number> {
  const to = ctx.now();
  const from = new Date(to.getTime() - lookbackHours * 3_600_000);
  let payIns;
  try {
    payIns = await ctx.payments.listPayIns({ from, to });
  } catch (error) {
    if (error instanceof ProviderError) {
      ctx.log.warn({ err: error }, 'pay-in recovery skipped');
      return 0;
    }
    throw error;
  }
  if (payIns.length === 0) return 0;
  const known = await ctx.db
    .select({ ref: salaryPayments.providerReference })
    .from(salaryPayments)
    .where(
      and(
        eq(salaryPayments.provider, ctx.payments.name),
        inArray(
          salaryPayments.providerReference,
          payIns.map((p) => p.reference),
        ),
      ),
    );
  const seen = new Set(known.map((k) => k.ref));
  let recovered = 0;
  for (const payIn of payIns.filter((p) => !seen.has(p.reference))) {
    if (await creditPayIn(ctx, payIn)) recovered++;
  }
  if (recovered) ctx.log.warn({ recovered }, 'credited salaries whose webhook was missed');
  return recovered;
}

/**
 * Asks the provider about every test salary still waiting. Webhooks are faster, but they can be lost, cannot reach
 * a laptop, and not every provider lists these payments. One that stays unconfirmed for a day is given up.
 */
export async function confirmPayIns(ctx: Ctx): Promise<void> {
  const dayAgo = new Date(ctx.now().getTime() - 86_400_000);
  const waiting = await ctx.db
    .select()
    .from(payinRuns)
    .where(eq(payinRuns.status, 'awaiting_confirmation'))
    .limit(50);
  for (const run of waiting) {
    try {
      await creditPayIn(ctx, await ctx.payments.getPayIn(run.providerReference));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.kind === 'not_found' && run.createdAt < dayAgo)
        await ctx.db
          .update(payinRuns)
          .set({ status: 'failed', failureReason: 'The provider never confirmed this pay-in' })
          .where(and(eq(payinRuns.id, run.id), eq(payinRuns.status, 'awaiting_confirmation')));
    }
  }
}

interface Check {
  kind: string;
  severity: 'info' | 'high' | 'critical';
  detail: string | null;
}

/**
 * Proves the books against themselves and against the provider. Each check opens an issue when it fails and
 * closes it again when it passes.
 */
export async function checkBooks(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  const one = async (query: ReturnType<typeof sql>) =>
    (await ctx.db.execute<Record<string, string | null>>(query))[0] ?? {};

  const totals = await one(sql`
    select coalesce(sum(amount) filter (where direction = 'debit'), 0) as debits,
           coalesce(sum(amount) filter (where direction = 'credit'), 0) as credits from paysplit.ledger_entries`);
  checks.push({
    kind: 'ledger_unbalanced',
    severity: 'critical',
    detail: totals.debits === totals.credits ? null : `Debits ${totals.debits}, credits ${totals.credits}`,
  });

  const negative = await one(sql`
    select count(*)::text as n from paysplit.account_balances where kind = 'liability' and balance < 0`);
  checks.push({
    kind: 'negative_balance',
    severity: 'critical',
    detail: negative.n === '0' ? null : `${negative.n} accounts are negative`,
  });

  const settled = await one(sql`
    select count(*)::text as n from paysplit.transfers t
      join paysplit.transactions x on x.id = t.transaction_id
     where t.status = 'success' and not exists (
       select 1 from paysplit.ledger_journals j where j.transaction_id = x.id and j.type = 'transfer_settled')`);
  checks.push({
    kind: 'settlement_missing',
    severity: 'critical',
    detail: settled.n === '0' ? null : `${settled.n} paid transfers have no settlement entry`,
  });

  const clearing = await one(sql`
    select (select balance from paysplit.account_balances where code = ${PLATFORM.clearing})::text as held,
           (select coalesce(sum(amount), 0) from paysplit.transfers where status in ('queued','in_flight','unknown','retrying'))::text as open`);
  checks.push({
    kind: 'clearing_mismatch',
    severity: 'critical',
    detail:
      clearing.held === clearing.open
        ? null
        : `Clearing holds ${clearing.held}, open transfers total ${clearing.open}`,
  });

  const overspent = await one(sql`
    select count(*)::text as n from (
      select p.id from paysplit.salary_payments p join paysplit.allocations a on a.salary_payment_id = p.id
       where a.status in ('pending','success') group by p.id, p.amount having sum(a.allocated_amount) > p.amount) x`);
  checks.push({
    kind: 'over_allocated',
    severity: 'critical',
    detail: overspent.n === '0' ? null : `${overspent.n} salaries have more allocated than received`,
  });

  try {
    const provider = await ctx.payments.getBalance('NGN');
    const [cash] = await ctx.db
      .select({
        balance: sql<string>`(select balance from paysplit.account_balances where account_id = ${ledgerAccounts.id})`,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.code, PLATFORM.cash));
    const ours = BigInt(cash!.balance);
    // Sandbox balances include activity from before PaySplit, so a difference here is information, not an alarm.
    checks.push({
      kind: 'provider_balance_differs',
      severity: 'info',
      detail: provider === ours ? null : `Provider ${formatMoney(provider)}, our books ${formatMoney(ours)}`,
    });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    ctx.log.warn({ err: error }, 'provider balance unavailable');
  }

  for (const check of checks) {
    if (check.detail)
      await raiseIssue(ctx.db, {
        kind: check.kind,
        severity: check.severity,
        subject: 'books',
        detail: check.detail,
      });
    else await resolveIssue(ctx.db, check.kind, 'books');
  }
  return checks;
}
