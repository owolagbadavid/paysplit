import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  adminProfileSchema,
  changePasswordSchema,
  emailOnlySchema,
  kycReviewSchema,
  loginSchema,
  payinSchema,
  resetPasswordSchema,
  transactionFilterSchema,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { admins } from '../db/schema.ts';
import { forgotPassword } from '../modules/accounts.ts';
import * as admin from '../modules/admin.ts';
import { audit } from '../modules/audit.ts';
import { reviewCase } from '../modules/kyc.ts';
import { checkBooks } from '../modules/reconciliation.ts';
import { adminFromToken, revokeSession } from '../modules/sessions.ts';
import { transferAttemptsFor } from '../modules/splits.ts';
import {
  adminOf,
  COOKIES,
  idParams,
  metaOf,
  OK,
  pageQuery,
  requireAdmin,
  sessionOf,
  setSessionCookie,
  strict,
  type App,
} from './support.ts';

export function adminRoutes(root: App, ctx: Ctx) {
  const tags = ['Admin'];

  root.post(
    '/v1/admin/auth/login',
    { config: strict(10), schema: { tags, summary: 'Administrator sign in', body: loginSchema } },
    async (r, reply) => {
      const { admin: row, session } = await admin.adminLogin(ctx, r.body, metaOf(r));
      setSessionCookie(ctx, reply, 'admin', session);
      return admin.adminView(row);
    },
  );
  root.post(
    '/v1/admin/auth/forgot-password',
    {
      config: strict(3),
      schema: { tags, summary: 'Email an administrator reset link', body: emailOnlySchema },
    },
    async (r, reply) => {
      const [row] = await ctx.db
        .select({ status: admins.status })
        .from(admins)
        .where(eq(admins.email, r.body.email));
      await forgotPassword(ctx, r.body.email, 'admin', row?.status === 'active');
      return reply.status(202).send(OK);
    },
  );
  root.post(
    '/v1/admin/auth/reset-password',
    {
      config: strict(5),
      schema: { tags, summary: 'Set a new administrator password', body: resetPasswordSchema },
    },
    async (r) => {
      await admin.adminResetPassword(ctx, r.body.token, r.body.password, metaOf(r));
      return OK;
    },
  );
  root.get(
    '/v1/admin/auth/session',
    { schema: { tags, summary: 'Current administrator, or null' } },
    async (r) => {
      const token = r.cookies[COOKIES.admin];
      const found = token ? await adminFromToken(ctx, token) : null;
      return { admin: found ? admin.adminView(found.admin) : null };
    },
  );

  root.register(async (scope) => {
    const app = scope as App;
    app.addHook('preHandler', requireAdmin(ctx));

    app.post(
      '/v1/admin/auth/logout',
      { schema: { tags, summary: 'Administrator sign out' } },
      async (r, reply) => {
        await revokeSession(ctx, ctx.db, sessionOf(r));
        await audit(ctx.db, {
          actor: { type: 'admin', id: adminOf(r).id },
          action: 'admin.logout',
          meta: metaOf(r),
        });
        reply.clearCookie(COOKIES.admin, { path: '/' });
        return OK;
      },
    );
    app.get('/v1/admin/overview', { schema: { tags, summary: 'Platform totals' } }, async () =>
      admin.overview(ctx),
    );
    app.get(
      '/v1/admin/users',
      {
        schema: {
          tags,
          summary: 'Search users',
          querystring: pageQuery.extend({
            q: z.string().trim().max(80).optional(),
            verification: z.enum(['verified', 'unverified', 'review']).optional(),
          }),
        },
      },
      async (r) => admin.listUsers(ctx, r.query),
    );
    app.get(
      '/v1/admin/users/:id',
      { schema: { tags, summary: 'User details', params: idParams } },
      async (r) => admin.userDetail(ctx, adminOf(r), r.params.id, metaOf(r)),
    );
    app.post(
      '/v1/admin/users/:id/kyc-review',
      {
        config: strict(20),
        schema: {
          tags,
          summary: 'Decide a verification the provider could not settle',
          params: idParams,
          body: kycReviewSchema,
        },
      },
      async (r) => {
        await reviewCase(ctx, adminOf(r).id, r.params.id, r.body, metaOf(r));
        return OK;
      },
    );
    app.get(
      '/v1/admin/users/:id/transactions',
      {
        schema: {
          tags,
          summary: 'A user’s transactions',
          params: idParams,
          querystring: transactionFilterSchema.extend({
            group: z.enum(['wallet', 'beneficiary']).optional(),
          }),
        },
      },
      async (r) => admin.userTransactions(ctx, r.params.id, r.query),
    );
    app.get(
      '/v1/admin/salary-transactions',
      {
        schema: {
          tags,
          summary: 'Salary received across the platform',
          querystring: pageQuery.extend({
            q: z.string().trim().max(80).optional(),
            userId: z.uuid().optional(),
            splitState: z.enum(['awaiting', 'split', 'held', 'no_rules', 'not_eligible']).optional(),
            from: z.iso.date().optional(),
            to: z.iso.date().optional(),
          }),
        },
      },
      async (r) => admin.salaryTransactions(ctx, r.query),
    );
    app.get(
      '/v1/admin/salary-transactions/:id',
      { schema: { tags, summary: 'Salary details and its splits', params: idParams } },
      async (r) => admin.salaryTransactionDetail(ctx, r.params.id),
    );
    app.get(
      '/v1/admin/transactions/:id/attempts',
      { schema: { tags, summary: 'Provider attempts behind a transfer', params: idParams } },
      async (r) => ({ items: await transferAttemptsFor(ctx, r.params.id) }),
    );

    app.post(
      '/v1/admin/pay-ins',
      {
        config: strict(10),
        schema: { tags, summary: 'Send a test salary through the provider sandbox', body: payinSchema },
      },
      async (r, reply) => reply.status(202).send(await admin.startPayIn(ctx, adminOf(r), r.body, metaOf(r))),
    );
    app.get(
      '/v1/admin/pay-ins',
      {
        schema: {
          tags,
          summary: 'Test salary runs',
          querystring: pageQuery.extend({ userId: z.uuid().optional() }),
        },
      },
      async (r) => admin.listPayIns(ctx, r.query),
    );
    app.get(
      '/v1/admin/pay-ins/:id',
      { schema: { tags, summary: 'Test salary run and its split', params: idParams } },
      async (r) => admin.payInRun(ctx, r.params.id),
    );
    app.post(
      '/v1/admin/pay-ins/:id/refresh',
      { config: strict(20), schema: { tags, summary: 'Ask the provider about a run', params: idParams } },
      async (r) => admin.refreshPayIn(ctx, r.params.id),
    );

    app.get('/v1/admin/reconciliation', { schema: { tags, summary: 'Reconciliation issues' } }, async () => ({
      items: await admin.listIssues(ctx),
    }));
    app.post(
      '/v1/admin/reconciliation/run',
      { config: strict(5), schema: { tags, summary: 'Check the books now' } },
      async (r) => {
        await audit(ctx.db, {
          actor: { type: 'admin', id: adminOf(r).id },
          action: 'admin.reconciliation_run',
          meta: metaOf(r),
        });
        return { checks: await checkBooks(ctx) };
      },
    );
    app.get(
      '/v1/admin/audit',
      {
        schema: {
          tags,
          summary: 'Audit log',
          querystring: pageQuery.extend({ userId: z.uuid().optional() }),
        },
      },
      async (r) => admin.listAudit(ctx, r.query),
    );

    app.get('/v1/admin/me', { schema: { tags, summary: 'Your administrator profile' } }, async (r) =>
      admin.adminView(adminOf(r)),
    );
    app.patch(
      '/v1/admin/me',
      { schema: { tags, summary: 'Update your administrator profile', body: adminProfileSchema } },
      async (r) => {
        await admin.updateAdmin(ctx, adminOf(r), r.body, metaOf(r));
        const [row] = await ctx.db
          .select()
          .from(admins)
          .where(eq(admins.id, adminOf(r).id));
        return admin.adminView(row!);
      },
    );
    app.post(
      '/v1/admin/me/change-password',
      {
        config: strict(5),
        schema: { tags, summary: 'Change your administrator password', body: changePasswordSchema },
      },
      async (r) => {
        await admin.adminChangePassword(ctx, adminOf(r), sessionOf(r), r.body, metaOf(r));
        return OK;
      },
    );
  });
}
