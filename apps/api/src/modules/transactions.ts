import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { TransactionFilter } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import {
  executions,
  ledgerEntries,
  ledgerJournals,
  rules,
  salaryAccounts,
  transactions,
  wallets,
} from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { UserRow } from './sessions.ts';

type TransactionRow = typeof transactions.$inferSelect;

/** Start of a calendar day in the person's timezone, as an instant the database can compare. */
const dayStart = (date: string, timezone: string, addDays = 0) =>
  sql`((${date}::date + ${addDays}::int)::timestamp at time zone ${timezone})`;

export function transactionView(t: TransactionRow) {
  return {
    id: t.id,
    reference: t.reference,
    type: t.type,
    status: t.status,
    amount: Number(t.amount),
    fee: Number(t.fee),
    currency: t.currency,
    description: t.description,
    category: t.category,
    source: t.source,
    destination: t.destination,
    walletId: t.walletId,
    beneficiaryId: t.beneficiaryId,
    ruleId: t.ruleId,
    executionId: t.executionId,
    providerReference: t.providerReference,
    failureReason: t.failureReason,
    isTest: t.isTest,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

export async function listTransactions(
  ctx: Ctx,
  user: Pick<UserRow, 'id' | 'timezone'>,
  filter: TransactionFilter & { group?: 'wallet' | 'beneficiary' | undefined },
) {
  const conditions: (SQL | undefined)[] = [
    eq(transactions.userId, user.id),
    filter.type && eq(transactions.type, filter.type),
    filter.status && eq(transactions.status, filter.status),
    filter.walletId && eq(transactions.walletId, filter.walletId),
    filter.beneficiaryId && eq(transactions.beneficiaryId, filter.beneficiaryId),
    filter.group === 'wallet' ? sql`${transactions.walletId} is not null` : undefined,
    filter.group === 'beneficiary' ? sql`${transactions.beneficiaryId} is not null` : undefined,
    filter.from && gte(transactions.createdAt, dayStart(filter.from, user.timezone)),
    filter.to && lt(transactions.createdAt, dayStart(filter.to, user.timezone, 1)),
    filter.q
      ? or(
          ilike(transactions.description, `%${filter.q.replace(/[%_\\]/g, '\\$&')}%`),
          ilike(transactions.reference, `%${filter.q.replace(/[%_\\]/g, '\\$&')}%`),
        )
      : undefined,
  ].filter(Boolean) as SQL[];
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    ctx.db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.createdAt), desc(transactions.reference))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    ctx.db.select({ n: count() }).from(transactions).where(where),
  ]);
  return { items: rows.map(transactionView), total: total!.n, page: filter.page, pageSize: filter.pageSize };
}

export async function transactionDetail(ctx: Ctx, userId: string, id: string) {
  const [row] = await ctx.db
    .select({ transaction: transactions, execution: executions, rule: rules })
    .from(transactions)
    .leftJoin(executions, eq(executions.id, transactions.executionId))
    .leftJoin(rules, eq(rules.id, transactions.ruleId))
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  if (!row) throw notFound('Transaction');
  return {
    ...transactionView(row.transaction),
    execution: row.execution
      ? { id: row.execution.id, reference: row.execution.reference, trigger: row.execution.trigger }
      : null,
    rule: row.rule ? { id: row.rule.id, name: row.rule.name, deleted: row.rule.status === 'deleted' } : null,
    hasReceipt: row.transaction.status === 'success',
  };
}

export interface StatementLine {
  date: Date;
  reference: string;
  description: string;
  type: string;
  moneyIn: bigint;
  moneyOut: bigint;
  balance: bigint;
}

export interface Statement {
  accountLabel: string;
  from: string;
  to: string;
  opening: bigint;
  closing: bigint;
  totalIn: bigint;
  totalOut: bigint;
  lines: StatementLine[];
}

const MAX_STATEMENT_DAYS = 400;

/**
 * Statement of one account, or of everything the person holds, read straight from ledger entries. Opening plus
 * money in minus money out always equals closing, because all four come from the same entries.
 */
export async function buildStatement(
  ctx: Ctx,
  user: UserRow,
  input: { from: string; to: string; account: string },
): Promise<Statement> {
  const days = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000;
  if (!(days >= 0 && days <= MAX_STATEMENT_DAYS))
    throw badRequest('invalid_period', 'Choose a period of up to 400 days, with the end after the start');

  const [salary] = await ctx.db.select().from(salaryAccounts).where(eq(salaryAccounts.userId, user.id));
  const owned = await ctx.db.select().from(wallets).where(eq(wallets.userId, user.id));
  let accountIds: string[];
  let accountLabel: string;
  if (input.account === 'all') {
    accountIds = [...(salary ? [salary.ledgerAccountId] : []), ...owned.map((w) => w.ledgerAccountId)];
    accountLabel = 'All accounts';
  } else if (input.account === 'salary') {
    accountIds = salary ? [salary.ledgerAccountId] : [];
    accountLabel = salary?.accountNumber
      ? `Salary account ••••${salary.accountNumber.slice(-4)}`
      : 'Salary account';
  } else {
    const wallet = owned.find((w) => w.id === input.account);
    if (!wallet) throw notFound('Wallet');
    accountIds = [wallet.ledgerAccountId];
    accountLabel = `${wallet.name} (wallet)`;
  }

  const start = dayStart(input.from, user.timezone);
  const end = dayStart(input.to, user.timezone, 1);
  const signed = sql<string>`case ${ledgerEntries.direction} when 'credit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end`;
  if (accountIds.length === 0)
    return {
      accountLabel,
      from: input.from,
      to: input.to,
      opening: 0n,
      closing: 0n,
      totalIn: 0n,
      totalOut: 0n,
      lines: [],
    };
  const inAccounts = sql`${ledgerEntries.accountId} in ${accountIds}`;

  const [before] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${signed}), 0)` })
    .from(ledgerEntries)
    .where(and(inAccounts, lt(ledgerEntries.createdAt, start)));
  const rows = await ctx.db
    .select({
      createdAt: ledgerEntries.createdAt,
      amount: signed,
      journal: ledgerJournals,
      transaction: transactions,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerEntries.journalId))
    .leftJoin(transactions, eq(transactions.id, ledgerJournals.transactionId))
    .where(and(inAccounts, gte(ledgerEntries.createdAt, start), lt(ledgerEntries.createdAt, end)))
    .orderBy(ledgerEntries.id);

  let balance = BigInt(before!.total);
  const opening = balance;
  let totalIn = 0n;
  let totalOut = 0n;
  const lines = rows.map((row): StatementLine => {
    const amount = BigInt(row.amount);
    balance += amount;
    const moneyIn = amount > 0n ? amount : 0n;
    const moneyOut = amount < 0n ? -amount : 0n;
    totalIn += moneyIn;
    totalOut += moneyOut;
    return {
      date: row.createdAt,
      reference: row.transaction?.reference ?? row.journal.reference,
      description: row.journal.description,
      type: row.journal.type,
      moneyIn,
      moneyOut,
      balance,
    };
  });
  return {
    accountLabel,
    from: input.from,
    to: input.to,
    opening,
    closing: balance,
    totalIn,
    totalOut,
    lines,
  };
}
