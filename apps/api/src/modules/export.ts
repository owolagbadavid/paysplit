import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import {
  auditLogs,
  beneficiaries,
  executions,
  kycCases,
  notifications,
  rules,
  transactions,
} from '../db/schema.ts';
import { publicUser } from './accounts.ts';
import type { UserRow } from './sessions.ts';
import { transactionView } from './transactions.ts';
import { listWallets, salaryAccountView } from './wallets.ts';

/** Everything held about a person, for them to keep. Their own account numbers are included in full. */
export async function exportData(ctx: Ctx, user: UserRow) {
  const mine = user.id;
  const [cases, people, ruleRows, splitRows, txRows, noticeRows, activity] = await Promise.all([
    ctx.db.select().from(kycCases).where(eq(kycCases.userId, mine)),
    ctx.db.select().from(beneficiaries).where(eq(beneficiaries.userId, mine)),
    ctx.db.select().from(rules).where(eq(rules.userId, mine)),
    ctx.db.select().from(executions).where(eq(executions.userId, mine)),
    ctx.db.select().from(transactions).where(eq(transactions.userId, mine)),
    ctx.db.select().from(notifications).where(eq(notifications.userId, mine)),
    ctx.db.select().from(auditLogs).where(eq(auditLogs.userId, mine)),
  ]);
  return {
    exportedAt: ctx.now(),
    profile: publicUser(user),
    verification: cases.map((c) => ({
      status: c.status,
      identityType: c.identityType,
      identityLast4: c.identityLast4,
      identityStatus: c.identityStatus,
      livenessStatus: c.livenessStatus,
      createdAt: c.createdAt,
    })),
    salaryAccount: await salaryAccountView(ctx, mine),
    wallets: await listWallets(ctx, mine),
    beneficiaries: people.map((b) => ({
      name: b.name,
      category: b.category,
      bankName: b.bankName,
      accountNumber: ctx.vault.decrypt(b.accountNumberEnc, `beneficiary:${mine}`),
      accountName: b.accountName,
      narration: b.narration,
      status: b.status,
    })),
    rules: ruleRows.map((r) => ({
      name: r.name,
      method: r.method,
      value: Number(r.value),
      priority: r.priority,
      status: r.status,
      createdAt: r.createdAt,
    })),
    splits: splitRows.map((e) => ({
      reference: e.reference,
      trigger: e.trigger,
      payCycle: e.payCycle,
      status: e.status,
      salaryAmount: Number(e.baseAmount),
      createdAt: e.createdAt,
    })),
    transactions: txRows.map(transactionView),
    notifications: noticeRows.map((n) => ({ title: n.title, body: n.body, createdAt: n.createdAt })),
    activity: activity.map((a) => ({ action: a.action, by: a.actorType, ip: a.ip, createdAt: a.createdAt })),
  };
}
