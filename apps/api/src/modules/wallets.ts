import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { WalletInput } from '@paysplit/core';
import { formatMoney } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { rules, salaryAccounts, transactions, users, wallets } from '../db/schema.ts';
import { conflict, notFound, uniqueViolation, unprocessable } from '../lib/errors.ts';
import { reference } from '../lib/ids.ts';
import { audit, type RequestMeta } from './audit.ts';
import { requireVerified } from './eligibility.ts';
import { withIdempotency } from './idempotency.ts';
import { balanceOf, balancesOf, credit, debit, openAccount, post } from './ledger.ts';
import { lockSalaryAccount } from './salary-accounts.ts';
import type { UserRow } from './sessions.ts';

type WalletRow = typeof wallets.$inferSelect;

function walletView(wallet: WalletRow, balance: bigint) {
  return {
    id: wallet.id,
    name: wallet.name,
    category: wallet.category,
    accent: wallet.accent,
    description: wallet.description,
    targetAmount: wallet.targetAmount === null ? null : Number(wallet.targetAmount),
    balance: Number(balance),
    status: wallet.status,
    createdAt: wallet.createdAt,
  };
}

export async function ownWallet(ctx: Ctx, userId: string, walletId: string): Promise<WalletRow> {
  const [wallet] = await ctx.db
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  if (!wallet) throw notFound('Wallet');
  return wallet;
}

export async function listWallets(ctx: Ctx, userId: string) {
  const rows = await ctx.db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.status, 'active')))
    .orderBy(asc(wallets.createdAt));
  const balances = await balancesOf(
    ctx.db,
    rows.map((w) => w.ledgerAccountId),
  );
  return rows.map((w) => walletView(w, balances.get(w.ledgerAccountId)!));
}

export async function walletDetail(ctx: Ctx, userId: string, walletId: string) {
  const wallet = await ownWallet(ctx, userId, walletId);
  const [totals] = await ctx.db
    .select({
      allocated: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'wallet_allocation' and ${transactions.status} = 'success'), 0)`,
      moved: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.type} = 'wallet_to_salary' and ${transactions.status} = 'success'), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.walletId, walletId));
  const [rule] = await ctx.db
    .select()
    .from(rules)
    .where(and(eq(rules.walletId, walletId), sql`status <> 'deleted'`));
  return {
    ...walletView(wallet, await balanceOf(ctx.db, wallet.ledgerAccountId)),
    totalAllocated: Number(totals!.allocated),
    totalMoved: Number(totals!.moved),
    rule: rule
      ? {
          id: rule.id,
          name: rule.name,
          method: rule.method,
          value: Number(rule.value),
          priority: rule.priority,
          status: rule.status,
          updatedAt: rule.updatedAt,
        }
      : null,
  };
}

const walletValues = (input: WalletInput) => ({
  name: input.name,
  category: input.category,
  accent: input.accent,
  targetAmount: input.targetAmount ? BigInt(input.targetAmount) : null,
  description: input.description || null,
});

const nameTaken = (error: unknown): never => {
  if (uniqueViolation(error)) throw conflict('name_taken', 'You already have a wallet with that name');
  throw error;
};

export async function createWallet(ctx: Ctx, user: UserRow, input: WalletInput, meta: RequestMeta) {
  return ctx.db
    .transaction(async (tx) => {
      const id = crypto.randomUUID();
      const ledgerAccountId = await openAccount(tx, {
        code: `wallet:${id}`,
        type: 'wallet',
        userId: user.id,
      });
      const [wallet] = await tx
        .insert(wallets)
        .values({ id, userId: user.id, ledgerAccountId, ...walletValues(input) })
        .returning();
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'wallet.created',
        target: { type: 'wallet', id },
        meta,
      });
      return walletView(wallet!, 0n);
    })
    .catch(nameTaken);
}

export async function updateWallet(
  ctx: Ctx,
  user: UserRow,
  walletId: string,
  input: WalletInput,
  meta: RequestMeta,
) {
  await ownWallet(ctx, user.id, walletId);
  await ctx.db
    .transaction(async (tx) => {
      await tx.update(wallets).set(walletValues(input)).where(eq(wallets.id, walletId));
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'wallet.updated',
        target: { type: 'wallet', id: walletId },
        meta,
      });
    })
    .catch(nameTaken);
  return walletDetail(ctx, user.id, walletId);
}

/** Archives an empty wallet and its rule. Its history stays. */
export async function archiveWallet(
  ctx: Ctx,
  user: UserRow,
  walletId: string,
  meta: RequestMeta,
): Promise<void> {
  const wallet = await ownWallet(ctx, user.id, walletId);
  await ctx.db.transaction(async (tx) => {
    await lockSalaryAccount(tx, user.id);
    if ((await balanceOf(tx, wallet.ledgerAccountId)) > 0n) {
      throw conflict(
        'wallet_not_empty',
        'Move the money back to your salary account before removing this wallet',
      );
    }
    await tx.update(wallets).set({ status: 'archived' }).where(eq(wallets.id, walletId));
    await tx
      .update(rules)
      .set({ status: 'deleted', deletedAt: ctx.now() })
      .where(and(eq(rules.walletId, walletId), inArray(rules.status, ['draft', 'active', 'paused'])));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'wallet.archived',
      target: { type: 'wallet', id: walletId },
      meta,
    });
  });
}

/** Moves money from a wallet back to the owner's salary account, inside the ledger. It is free and immediate. */
export async function moveToSalary(
  ctx: Ctx,
  user: UserRow,
  walletId: string,
  amount: number,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  requireVerified(user);
  const wallet = await ownWallet(ctx, user.id, walletId);
  const value = BigInt(amount);
  return ctx.db.transaction((tx) =>
    withIdempotency(tx, user.id, idempotencyKey, { walletId, amount }, async () => {
      const account = await lockSalaryAccount(tx, user.id);
      const [fresh] = await tx.select().from(users).where(eq(users.id, user.id));
      requireVerified(fresh!);
      if (!account || account.status !== 'active')
        throw conflict('no_salary_account', 'Your salary account is not ready yet');
      const available = await balanceOf(tx, wallet.ledgerAccountId);
      if (value > available) {
        throw unprocessable('insufficient_balance', `This wallet has ${formatMoney(available)} available`);
      }
      const [transaction] = await tx
        .insert(transactions)
        .values({
          reference: reference('PAY', ctx.now()),
          userId: user.id,
          type: 'wallet_to_salary',
          status: 'success',
          amount: value,
          description: `Moved from ${wallet.name}`,
          category: wallet.category,
          source: { label: wallet.name, detail: 'Wallet' },
          destination: {
            label: 'Salary account',
            detail: account.accountNumber ? `••••${account.accountNumber.slice(-4)}` : undefined,
          },
          walletId,
          completedAt: ctx.now(),
        })
        .returning();
      await post(tx, {
        reference: `move:${transaction!.id}`,
        type: 'wallet_to_salary',
        description: transaction!.description,
        transactionId: transaction!.id,
        postings: [debit(wallet.ledgerAccountId, value), credit(account.ledgerAccountId, value)],
      });
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'wallet.moved_to_salary',
        target: { type: 'wallet', id: walletId },
        metadata: { amount },
        meta,
      });
      return {
        transactionId: transaction!.id,
        reference: transaction!.reference,
        amount,
        status: 'success' as const,
      };
    }),
  );
}

export async function salaryAccountView(ctx: Ctx, userId: string) {
  const [account] = await ctx.db.select().from(salaryAccounts).where(eq(salaryAccounts.userId, userId));
  if (!account) return null;
  return {
    status: account.status,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName,
    failureReason: account.failureReason,
    balance: Number(await balanceOf(ctx.db, account.ledgerAccountId)),
  };
}
