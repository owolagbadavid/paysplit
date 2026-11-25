import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  beneficiarySchema,
  beneficiaryUpdateSchema,
  changePasswordSchema,
  closeAccountSchema,
  identitySchema,
  incomeSchema,
  livenessSchema,
  moveSchema,
  notificationPrefsSchema,
  profileSchema,
  resolveAccountSchema,
  ruleSchema,
  ruleUpdateSchema,
  runNowSchema,
  statementSchema,
  transactionFilterSchema,
  updateMeSchema,
  walletSchema,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { auditLogs, notifications, sessions, users } from '../db/schema.ts';
import { conflict, notFound } from '../lib/errors.ts';
import * as accounts from '../modules/accounts.ts';
import { audit } from '../modules/audit.ts';
import * as beneficiaries from '../modules/beneficiaries.ts';
import { dashboard } from '../modules/dashboard.ts';
import { receiptPdf, statementCsv, statementPdf } from '../modules/documents.ts';
import { exportData } from '../modules/export.ts';
import * as kyc from '../modules/kyc.ts';
import * as rules from '../modules/rules.ts';
import { retryProvisioning } from '../modules/salary-accounts.ts';
import { listSessions, revokeSession, type UserRow } from '../modules/sessions.ts';
import * as splits from '../modules/splits.ts';
import * as transactions from '../modules/transactions.ts';
import * as wallets from '../modules/wallets.ts';
import {
  COOKIES,
  idempotencyKey,
  idParams,
  metaOf,
  OK,
  pageQuery,
  requireUser,
  sessionOf,
  strict,
  userOf,
  type App,
} from './support.ts';

const reload = async (ctx: Ctx, user: UserRow) =>
  (await ctx.db.select().from(users).where(eq(users.id, user.id)))[0]!;

export function customerRoutes(root: App, ctx: Ctx) {
  root.register(async (scope) => {
    const app = scope as App;
    app.addHook('preHandler', requireUser(ctx));

    const account = ['Account'];
    app.get('/v1/me', { schema: { tags: account, summary: 'Your profile' } }, async (r) =>
      accounts.publicUser(userOf(r)),
    );
    app.patch(
      '/v1/me',
      { schema: { tags: account, summary: 'Update your name or phone', body: updateMeSchema } },
      async (r) => {
        await accounts.updateMe(ctx, userOf(r), r.body, metaOf(r));
        return accounts.publicUser(await reload(ctx, userOf(r)));
      },
    );
    app.put(
      '/v1/me/profile',
      { schema: { tags: account, summary: 'Set country and phone number', body: profileSchema } },
      async (r) => {
        await accounts.setProfile(ctx, userOf(r), r.body, metaOf(r));
        return accounts.publicUser(await reload(ctx, userOf(r)));
      },
    );
    app.put(
      '/v1/me/income',
      {
        schema: {
          tags: account,
          summary: 'Set employer, expected salary and expected salary day',
          body: incomeSchema,
        },
      },
      async (r) => {
        await accounts.setIncome(ctx, userOf(r), r.body, metaOf(r));
        return accounts.publicUser(await reload(ctx, userOf(r)));
      },
    );
    app.put(
      '/v1/me/notification-preferences',
      { schema: { tags: account, summary: 'Choose optional emails', body: notificationPrefsSchema } },
      async (r) => {
        await accounts.setPrefs(ctx, userOf(r), r.body);
        return r.body;
      },
    );
    app.post(
      '/v1/me/setup/skip',
      { schema: { tags: account, summary: 'Hide the setup wizard' } },
      async (r) => {
        await ctx.db
          .update(users)
          .set({ setupSkippedAt: ctx.now() })
          .where(eq(users.id, userOf(r).id));
        return OK;
      },
    );
    app.post(
      '/v1/me/change-password',
      {
        config: strict(5),
        schema: { tags: account, summary: 'Change your password', body: changePasswordSchema },
      },
      async (r) => {
        await accounts.changePassword(ctx, userOf(r), sessionOf(r), r.body, metaOf(r));
        return OK;
      },
    );
    app.get(
      '/v1/me/sessions',
      { schema: { tags: account, summary: 'Devices signed in to your account' } },
      async (r) =>
        (await listSessions(ctx, userOf(r).id)).map((s) => ({ ...s, current: s.id === sessionOf(r) })),
    );
    app.delete(
      '/v1/me/sessions/:id',
      { schema: { tags: account, summary: 'Sign a device out', params: idParams } },
      async (r) => {
        const [session] = await ctx.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, r.params.id), eq(sessions.userId, userOf(r).id)));
        if (!session) throw notFound('Session');
        await revokeSession(ctx, ctx.db, session.id);
        await audit(ctx.db, {
          actor: { type: 'user', id: userOf(r).id },
          userId: userOf(r).id,
          action: 'session.revoked',
          meta: metaOf(r),
        });
        return OK;
      },
    );
    app.get(
      '/v1/me/activity',
      { schema: { tags: account, summary: 'Security activity on your account', querystring: pageQuery } },
      async (r) => {
        const mine = eq(auditLogs.userId, userOf(r).id);
        const [items, [total]] = await Promise.all([
          ctx.db
            .select({
              id: auditLogs.id,
              action: auditLogs.action,
              actorType: auditLogs.actorType,
              ip: auditLogs.ip,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .where(mine)
            .orderBy(desc(auditLogs.createdAt))
            .limit(r.query.pageSize)
            .offset((r.query.page - 1) * r.query.pageSize),
          ctx.db.select({ n: count() }).from(auditLogs).where(mine),
        ]);
        return { items, total: total!.n, ...r.query };
      },
    );
    app.get(
      '/v1/me/export',
      { config: strict(3), schema: { tags: account, summary: 'Download everything held about you' } },
      async (r, reply) => {
        await audit(ctx.db, {
          actor: { type: 'user', id: userOf(r).id },
          userId: userOf(r).id,
          action: 'data.exported',
          meta: metaOf(r),
        });
        return reply
          .header('content-type', 'application/json')
          .header('content-disposition', 'attachment; filename="paysplit-data.json"')
          .send(JSON.stringify(await exportData(ctx, userOf(r)), null, 2));
      },
    );
    app.post(
      '/v1/me/close',
      {
        config: strict(3),
        schema: { tags: account, summary: 'Close your account', body: closeAccountSchema },
      },
      async (r, reply) => {
        await accounts.closeAccount(ctx, userOf(r), r.body.password, metaOf(r));
        reply.clearCookie(COOKIES.user, { path: '/' });
        return OK;
      },
    );

    const kycTag = ['Verification'];
    app.get(
      '/v1/kyc',
      { schema: { tags: kycTag, summary: 'Verification status and next step' } },
      async (r) => kyc.kycState(ctx, userOf(r)),
    );
    app.post(
      '/v1/kyc/identity',
      { config: strict(6), schema: { tags: kycTag, summary: 'Verify a BVN or NIN', body: identitySchema } },
      async (r) => {
        await kyc.submitIdentity(ctx, userOf(r), r.body, metaOf(r));
        return kyc.kycState(ctx, await reload(ctx, userOf(r)));
      },
    );
    app.post(
      '/v1/kyc/liveness',
      {
        config: strict(6),
        bodyLimit: 4_000_000,
        schema: { tags: kycTag, summary: 'Submit a selfie for the liveness check', body: livenessSchema },
      },
      async (r) => {
        await kyc.submitLiveness(ctx, userOf(r), r.body.image, metaOf(r));
        return kyc.kycState(ctx, await reload(ctx, userOf(r)));
      },
    );

    const money = ['Money'];
    app.get('/v1/dashboard', { schema: { tags: money, summary: 'Dashboard summary' } }, async (r) =>
      dashboard(ctx, userOf(r)),
    );
    app.get(
      '/v1/salary-account',
      { schema: { tags: money, summary: 'Your dedicated salary account' } },
      async (r) => ({ account: await wallets.salaryAccountView(ctx, userOf(r).id) }),
    );
    app.post(
      '/v1/salary-account/provision',
      { config: strict(5), schema: { tags: money, summary: 'Retry setting up your salary account' } },
      async (r, reply) => {
        await retryProvisioning(ctx, userOf(r));
        return reply.status(202).send(OK);
      },
    );

    const walletTag = ['Wallets'];
    app.get('/v1/wallets', { schema: { tags: walletTag, summary: 'List wallets' } }, async (r) => ({
      items: await wallets.listWallets(ctx, userOf(r).id),
    }));
    app.post(
      '/v1/wallets',
      { schema: { tags: walletTag, summary: 'Create a wallet', body: walletSchema } },
      async (r, reply) =>
        reply.status(201).send(await wallets.createWallet(ctx, userOf(r), r.body, metaOf(r))),
    );
    app.get(
      '/v1/wallets/:id',
      { schema: { tags: walletTag, summary: 'Wallet details', params: idParams } },
      async (r) => wallets.walletDetail(ctx, userOf(r).id, r.params.id),
    );
    app.patch(
      '/v1/wallets/:id',
      { schema: { tags: walletTag, summary: 'Edit a wallet', params: idParams, body: walletSchema } },
      async (r) => wallets.updateWallet(ctx, userOf(r), r.params.id, r.body, metaOf(r)),
    );
    app.delete(
      '/v1/wallets/:id',
      { schema: { tags: walletTag, summary: 'Remove an empty wallet', params: idParams } },
      async (r) => {
        await wallets.archiveWallet(ctx, userOf(r), r.params.id, metaOf(r));
        return OK;
      },
    );
    app.post(
      '/v1/wallets/:id/move',
      {
        config: strict(20),
        schema: {
          tags: walletTag,
          summary: 'Move money back to the salary account',
          params: idParams,
          body: moveSchema,
        },
      },
      async (r) =>
        wallets.moveToSalary(ctx, userOf(r), r.params.id, r.body.amount, idempotencyKey(r), metaOf(r)),
    );

    const beneficiaryTag = ['Beneficiaries'];
    app.get('/v1/banks', { schema: { tags: beneficiaryTag, summary: 'Supported banks' } }, async () => ({
      items: await beneficiaries.listBanks(ctx),
    }));
    app.post(
      '/v1/banks/resolve',
      {
        config: strict(20),
        schema: { tags: beneficiaryTag, summary: 'Look up an account name', body: resolveAccountSchema },
      },
      async (r) => beneficiaries.resolveAccount(ctx, r.body),
    );
    app.get(
      '/v1/beneficiaries',
      { schema: { tags: beneficiaryTag, summary: 'List beneficiaries' } },
      async (r) => ({ items: await beneficiaries.listBeneficiaries(ctx, userOf(r).id) }),
    );
    app.post(
      '/v1/beneficiaries',
      {
        config: strict(20),
        schema: { tags: beneficiaryTag, summary: 'Save a beneficiary', body: beneficiarySchema },
      },
      async (r, reply) =>
        reply.status(201).send(await beneficiaries.createBeneficiary(ctx, userOf(r), r.body, metaOf(r))),
    );
    app.get(
      '/v1/beneficiaries/:id',
      {
        schema: {
          tags: beneficiaryTag,
          summary: 'Beneficiary details',
          params: idParams,
          querystring: z.object({ reveal: z.enum(['true', 'false']).optional() }),
        },
      },
      async (r) => {
        const reveal = r.query.reveal === 'true';
        if (reveal) {
          await audit(ctx.db, {
            actor: { type: 'user', id: userOf(r).id },
            userId: userOf(r).id,
            action: 'beneficiary.account_revealed',
            target: { type: 'beneficiary', id: r.params.id },
            meta: metaOf(r),
          });
        }
        return beneficiaries.beneficiaryDetail(ctx, userOf(r), r.params.id, { reveal });
      },
    );
    app.patch(
      '/v1/beneficiaries/:id',
      {
        schema: {
          tags: beneficiaryTag,
          summary: 'Edit a beneficiary',
          params: idParams,
          body: beneficiaryUpdateSchema,
        },
      },
      async (r) => beneficiaries.updateBeneficiary(ctx, userOf(r), r.params.id, r.body, metaOf(r)),
    );
    app.delete(
      '/v1/beneficiaries/:id',
      { schema: { tags: beneficiaryTag, summary: 'Remove a beneficiary', params: idParams } },
      async (r) => {
        await beneficiaries.removeBeneficiary(ctx, userOf(r), r.params.id, metaOf(r));
        return OK;
      },
    );

    const ruleTag = ['Split rules'];
    app.get(
      '/v1/rules',
      { schema: { tags: ruleTag, summary: 'Rules and what they would do to your salary' } },
      async (r) => rules.rulesOverview(ctx, userOf(r)),
    );
    app.post(
      '/v1/rules',
      { schema: { tags: ruleTag, summary: 'Create a draft rule', body: ruleSchema } },
      async (r, reply) => reply.status(201).send(await rules.createRule(ctx, userOf(r), r.body, metaOf(r))),
    );
    app.get(
      '/v1/rules/:id',
      { schema: { tags: ruleTag, summary: 'Rule details and history', params: idParams } },
      async (r) => rules.ruleDetail(ctx, userOf(r), r.params.id),
    );
    app.put(
      '/v1/rules/:id',
      { schema: { tags: ruleTag, summary: 'Reconfigure a rule', params: idParams, body: ruleUpdateSchema } },
      async (r) => rules.updateRule(ctx, userOf(r), r.params.id, r.body, metaOf(r)),
    );
    for (const action of ['activate', 'pause', 'resume'] as const) {
      app.post(
        `/v1/rules/:id/${action}`,
        {
          schema: {
            tags: ruleTag,
            summary: `${action[0]!.toUpperCase()}${action.slice(1)} a rule`,
            params: idParams,
          },
        },
        async (r) => {
          const { id } = r.params as { id: string };
          await rules.setRuleStatus(ctx, userOf(r), id, action, metaOf(r));
          return rules.ruleDetail(ctx, userOf(r), id);
        },
      );
    }
    app.delete(
      '/v1/rules/:id',
      { schema: { tags: ruleTag, summary: 'Delete a rule and keep its history', params: idParams } },
      async (r) => {
        await rules.setRuleStatus(ctx, userOf(r), r.params.id, 'delete', metaOf(r));
        return OK;
      },
    );

    const splitTag = ['Splits'];
    app.get(
      '/v1/splits',
      { schema: { tags: splitTag, summary: 'Split history', querystring: pageQuery } },
      async (r) => splits.listExecutions(ctx, userOf(r).id, r.query.page, r.query.pageSize),
    );
    app.get(
      '/v1/splits/run-now',
      { schema: { tags: splitTag, summary: 'Review what Run Now would do' } },
      async (r) => ({ options: await splits.previewRunNow(ctx, userOf(r)) }),
    );
    app.post(
      '/v1/splits/run-now',
      {
        config: strict(10),
        schema: { tags: splitTag, summary: 'Run the reviewed split', body: runNowSchema },
      },
      async (r) => splits.runNow(ctx, userOf(r), r.body, idempotencyKey(r), metaOf(r)),
    );
    app.get(
      '/v1/splits/:id',
      { schema: { tags: splitTag, summary: 'Split breakdown', params: idParams } },
      async (r) => splits.executionDetail(ctx, r.params.id, userOf(r).id),
    );

    const transactionTag = ['Transactions'];
    app.get(
      '/v1/transactions',
      {
        schema: {
          tags: transactionTag,
          summary: 'Search transactions',
          querystring: transactionFilterSchema.extend({
            group: z.enum(['wallet', 'beneficiary']).optional(),
          }),
        },
      },
      async (r) => transactions.listTransactions(ctx, userOf(r), r.query),
    );
    app.get(
      '/v1/transactions/:id',
      { schema: { tags: transactionTag, summary: 'Transaction details', params: idParams } },
      async (r) => transactions.transactionDetail(ctx, userOf(r).id, r.params.id),
    );
    app.get(
      '/v1/transactions/:id/receipt',
      { schema: { tags: transactionTag, summary: 'Receipt as PDF', params: idParams } },
      async (r, reply) => {
        const detail = await transactions.transactionDetail(ctx, userOf(r).id, r.params.id);
        if (!detail.hasReceipt)
          throw conflict('no_receipt', 'A receipt is available once the transaction succeeds');
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="paysplit-receipt-${detail.reference}.pdf"`)
          .send(await receiptPdf(detail, userOf(r).timezone));
      },
    );
    app.get(
      '/v1/statements',
      {
        config: strict(20),
        schema: {
          tags: transactionTag,
          summary: 'Account statement as CSV or PDF',
          querystring: statementSchema,
        },
      },
      async (r, reply) => {
        const user = userOf(r);
        const statement = await transactions.buildStatement(ctx, user, r.query);
        const name = `paysplit-statement-${r.query.from}-to-${r.query.to}.${r.query.format}`;
        reply.header('content-disposition', `attachment; filename="${name}"`);
        return r.query.format === 'csv'
          ? reply.header('content-type', 'text/csv; charset=utf-8').send(statementCsv(statement))
          : reply
              .header('content-type', 'application/pdf')
              .send(await statementPdf(statement, `${user.firstName} ${user.lastName}`, user.timezone));
      },
    );

    const noticeTag = ['Notifications'];
    app.get(
      '/v1/notifications',
      { schema: { tags: noticeTag, summary: 'Your notifications', querystring: pageQuery } },
      async (r) => {
        const mine = eq(notifications.userId, userOf(r).id);
        const [items, [total], [unread]] = await Promise.all([
          ctx.db
            .select()
            .from(notifications)
            .where(mine)
            .orderBy(desc(notifications.createdAt))
            .limit(r.query.pageSize)
            .offset((r.query.page - 1) * r.query.pageSize),
          ctx.db.select({ n: count() }).from(notifications).where(mine),
          ctx.db
            .select({ n: count() })
            .from(notifications)
            .where(and(mine, isNull(notifications.readAt))),
        ]);
        return {
          items: items.map((n) => ({
            id: n.id,
            type: n.type,
            severity: n.severity,
            title: n.title,
            body: n.body,
            link: n.link,
            readAt: n.readAt,
            createdAt: n.createdAt,
          })),
          total: total!.n,
          unread: unread!.n,
          ...r.query,
        };
      },
    );
    app.post(
      '/v1/notifications/read',
      {
        schema: {
          tags: noticeTag,
          summary: 'Mark one or all as read',
          body: z.object({ id: z.uuid().optional() }),
        },
      },
      async (r) => {
        await ctx.db
          .update(notifications)
          .set({ readAt: ctx.now() })
          .where(
            and(
              eq(notifications.userId, userOf(r).id),
              isNull(notifications.readAt),
              r.body.id ? eq(notifications.id, r.body.id) : undefined,
            ),
          );
        return OK;
      },
    );
  });
}
