import { eq, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../db/client.ts';
import { ledgerAccounts, ledgerEntries, ledgerJournals } from '../db/schema.ts';

export const PLATFORM = {
  cash: 'platform:provider_cash',
  clearing: 'platform:payout_clearing',
  fees: 'platform:provider_fees',
} as const;

const platformIds = new Map<string, string>();

export async function platformAccount(ex: Executor, code: string): Promise<string> {
  const cached = platformIds.get(code);
  if (cached) return cached;
  const [row] = await ex
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, code));
  if (!row) throw new Error(`Missing platform account ${code}`);
  platformIds.set(code, row.id);
  return row.id;
}

/** Tests recreate the schema between runs, which changes the account IDs. */
export function forgetPlatformAccounts(): void {
  platformIds.clear();
}

export async function openAccount(
  tx: Tx,
  input: { code: string; type: 'user_salary' | 'wallet'; userId: string },
): Promise<string> {
  const [row] = await tx
    .insert(ledgerAccounts)
    .values({ ...input, kind: 'liability' })
    .returning({ id: ledgerAccounts.id });
  return row!.id;
}

export interface Posting {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: bigint;
}

export const debit = (accountId: string, amount: bigint): Posting => ({
  accountId,
  direction: 'debit',
  amount,
});
export const credit = (accountId: string, amount: bigint): Posting => ({
  accountId,
  direction: 'credit',
  amount,
});

/**
 * Writes one balanced journal. `reference` names the business event and is unique, so posting the same event
 * twice fails rather than moving money twice. Corrections are new journals; nothing is ever edited.
 */
export async function post(
  tx: Tx,
  input: {
    reference: string;
    type: string;
    description: string;
    transactionId?: string;
    reversesJournalReference?: string;
    postings: Posting[];
  },
): Promise<string> {
  const postings = input.postings.filter((p) => p.amount !== 0n);
  const total = (direction: Posting['direction']) =>
    postings.reduce((sum, p) => (p.direction === direction ? sum + p.amount : sum), 0n);
  if (postings.some((p) => p.amount < 0n) || total('debit') !== total('credit')) {
    throw new Error(`Unbalanced journal ${input.reference}`);
  }

  let reverses: string | null = null;
  if (input.reversesJournalReference) {
    const [original] = await tx
      .select({ id: ledgerJournals.id })
      .from(ledgerJournals)
      .where(eq(ledgerJournals.reference, input.reversesJournalReference));
    if (!original) throw new Error(`Cannot reverse missing journal ${input.reversesJournalReference}`);
    reverses = original.id;
  }

  const [journal] = await tx
    .insert(ledgerJournals)
    .values({
      reference: input.reference,
      type: input.type,
      description: input.description,
      transactionId: input.transactionId ?? null,
      reversesJournalId: reverses,
    })
    .returning({ id: ledgerJournals.id });
  await tx.insert(ledgerEntries).values(postings.map((p) => ({ journalId: journal!.id, ...p })));
  return journal!.id;
}

/** Balance of a customer account, derived from its entries. */
export async function balanceOf(ex: Executor, accountId: string): Promise<bigint> {
  const [row] = await ex
    .select({
      balance: sql<string>`coalesce(sum(case ${ledgerEntries.direction} when 'credit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return BigInt(row!.balance);
}

export async function balancesOf(ex: Executor, accountIds: string[]): Promise<Map<string, bigint>> {
  const balances = new Map(accountIds.map((id) => [id, 0n]));
  if (accountIds.length === 0) return balances;
  const rows = await ex.execute<{ account_id: string; balance: string }>(
    sql`select account_id, balance from paysplit.account_balances where account_id in ${accountIds}`,
  );
  for (const row of rows) balances.set(row.account_id, BigInt(row.balance));
  return balances;
}
