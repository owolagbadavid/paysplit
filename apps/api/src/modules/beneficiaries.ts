import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BeneficiaryInput, BeneficiaryUpdateInput } from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { bankCache, beneficiaries, rules, transactions } from '../db/schema.ts';
import {
  badRequest,
  conflict,
  notFound,
  ProviderError,
  unavailable,
  uniqueViolation,
  unprocessable,
} from '../lib/errors.ts';
import type { Bank } from '../ports/payments.ts';
import { audit, type RequestMeta } from './audit.ts';
import type { UserRow } from './sessions.ts';

type BeneficiaryRow = typeof beneficiaries.$inferSelect;
const BANKS_FRESH_MS = 24 * 3_600_000;

const mask = (last4: string) => `••••••${last4}`;

function beneficiaryView(row: BeneficiaryRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    bankCode: row.bankCode,
    bankName: row.bankName,
    accountNumberMasked: mask(row.accountLast4),
    accountName: row.accountName,
    narration: row.narration,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** Banks from the provider, kept a day. A stale list is served when the provider is down. */
export async function listBanks(ctx: Ctx): Promise<Bank[]> {
  const [cached] = await ctx.db.select().from(bankCache).where(eq(bankCache.provider, ctx.payments.name));
  if (cached && ctx.now().getTime() - cached.fetchedAt.getTime() < BANKS_FRESH_MS) return cached.banks;
  try {
    const banks = await ctx.payments.listBanks();
    const values = { banks, fetchedAt: ctx.now() };
    await ctx.db
      .insert(bankCache)
      .values({ provider: ctx.payments.name, ...values })
      .onConflictDoUpdate({ target: bankCache.provider, set: values });
    return banks;
  } catch (error) {
    if (cached) return cached.banks;
    ctx.log.warn({ err: error }, 'bank list unavailable');
    throw unavailable('The bank list is not available right now. Try again shortly.');
  }
}

export async function resolveAccount(ctx: Ctx, input: { bankCode: string; accountNumber: string }) {
  const bank = (await listBanks(ctx)).find((b) => b.code === input.bankCode);
  if (!bank) throw badRequest('unknown_bank', 'Choose a bank from the list');
  try {
    const { accountName } = await ctx.payments.resolveAccount(input.bankCode, input.accountNumber);
    return { accountName, bankName: bank.name };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.kind === 'rejected' || error.kind === 'not_found') {
      throw unprocessable(
        'account_not_found',
        'We could not find that account. Check the bank and account number.',
        { provider: error.message },
      );
    }
    throw unavailable('Account lookup is not responding. Try again shortly.');
  }
}

async function prepareAccount(ctx: Ctx, userId: string, input: { bankCode: string; accountNumber: string }) {
  const { accountName, bankName } = await resolveAccount(ctx, input);
  let recipientCode: string;
  try {
    ({ recipientCode } = await ctx.payments.createRecipient({ name: accountName, ...input }));
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.kind === 'rejected' || error.kind === 'not_found')
      throw unprocessable('account_refused', 'This account cannot receive transfers.');
    throw unavailable('The payment provider is not responding. Try again shortly.');
  }
  return {
    bankCode: input.bankCode,
    bankName,
    accountName,
    recipientCode,
    accountLast4: input.accountNumber.slice(-4),
    accountNumberEnc: ctx.vault.encrypt(input.accountNumber, `beneficiary:${userId}`),
    accountFingerprint: ctx.vault.fingerprint('account', `${input.bankCode}:${input.accountNumber}`),
  };
}

const duplicate = (error: unknown): never => {
  if (uniqueViolation(error)) throw conflict('beneficiary_exists', 'You already saved this account');
  throw error;
};

export async function ownBeneficiary(ctx: Ctx, userId: string, id: string): Promise<BeneficiaryRow> {
  const [row] = await ctx.db
    .select()
    .from(beneficiaries)
    .where(and(eq(beneficiaries.id, id), eq(beneficiaries.userId, userId)));
  if (!row) throw notFound('Beneficiary');
  return row;
}

export async function listBeneficiaries(ctx: Ctx, userId: string) {
  const rows = await ctx.db
    .select({ beneficiary: beneficiaries, rule: rules })
    .from(beneficiaries)
    .leftJoin(rules, and(eq(rules.beneficiaryId, beneficiaries.id), sql`${rules.status} <> 'deleted'`))
    .where(and(eq(beneficiaries.userId, userId), eq(beneficiaries.status, 'active')))
    .orderBy(asc(beneficiaries.createdAt));
  return rows.map(({ beneficiary, rule }) => ({
    ...beneficiaryView(beneficiary),
    rule: rule ? { id: rule.id, status: rule.status } : null,
  }));
}

export async function beneficiaryDetail(
  ctx: Ctx,
  user: UserRow,
  id: string,
  options: { reveal?: boolean } = {},
) {
  const row = await ownBeneficiary(ctx, user.id, id);
  const [rule] = await ctx.db
    .select()
    .from(rules)
    .where(and(eq(rules.beneficiaryId, id), sql`status <> 'deleted'`));
  const [totals] = await ctx.db
    .select({
      sent: sql<string>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'success'), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.beneficiaryId, id));
  return {
    ...beneficiaryView(row),
    accountNumber: options.reveal ? ctx.vault.decrypt(row.accountNumberEnc, `beneficiary:${user.id}`) : null,
    totalSent: Number(totals!.sent),
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

export async function createBeneficiary(ctx: Ctx, user: UserRow, input: BeneficiaryInput, meta: RequestMeta) {
  const account = await prepareAccount(ctx, user.id, input);
  return ctx.db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(beneficiaries)
        .values({
          userId: user.id,
          name: input.name,
          category: input.category,
          narration: input.narration || null,
          ...account,
        })
        .returning();
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: 'beneficiary.created',
        target: { type: 'beneficiary', id: row!.id },
        meta,
      });
      return beneficiaryView(row!);
    })
    .catch(duplicate);
}

export async function updateBeneficiary(
  ctx: Ctx,
  user: UserRow,
  id: string,
  input: BeneficiaryUpdateInput,
  meta: RequestMeta,
) {
  await ownBeneficiary(ctx, user.id, id);
  const changesAccount = Boolean(input.bankCode && input.accountNumber);
  if (!changesAccount && (input.bankCode || input.accountNumber))
    throw badRequest('incomplete_account', 'Enter both the bank and the account number');
  const account = changesAccount
    ? await prepareAccount(ctx, user.id, { bankCode: input.bankCode!, accountNumber: input.accountNumber! })
    : {};
  await ctx.db
    .transaction(async (tx) => {
      await tx
        .update(beneficiaries)
        .set({ name: input.name, category: input.category, narration: input.narration || null, ...account })
        .where(eq(beneficiaries.id, id));
      await audit(tx, {
        actor: { type: 'user', id: user.id },
        userId: user.id,
        action: changesAccount ? 'beneficiary.account_changed' : 'beneficiary.updated',
        target: { type: 'beneficiary', id },
        meta,
      });
    })
    .catch(duplicate);
  return beneficiaryDetail(ctx, user, id);
}

/** Removes a beneficiary and its rule. Past transfers keep their own copy of who was paid. */
export async function removeBeneficiary(
  ctx: Ctx,
  user: UserRow,
  id: string,
  meta: RequestMeta,
): Promise<void> {
  await ownBeneficiary(ctx, user.id, id);
  await ctx.db.transaction(async (tx) => {
    await tx.update(beneficiaries).set({ status: 'removed' }).where(eq(beneficiaries.id, id));
    await tx
      .update(rules)
      .set({ status: 'deleted', deletedAt: ctx.now() })
      .where(and(eq(rules.beneficiaryId, id), inArray(rules.status, ['draft', 'active', 'paused'])));
    await audit(tx, {
      actor: { type: 'user', id: user.id },
      userId: user.id,
      action: 'beneficiary.removed',
      target: { type: 'beneficiary', id },
      meta,
    });
  });
}
