import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@paysplit/core';
import type { Ctx } from '../context.ts';
import { users } from '../db/schema.ts';
import * as accounts from '../modules/accounts.ts';
import { audit } from '../modules/audit.ts';
import { revokeSession, userFromToken } from '../modules/sessions.ts';
import {
  COOKIES,
  cookieOptions,
  metaOf,
  OK,
  requireUser,
  sessionOf,
  setSessionCookie,
  strict,
  userOf,
  type App,
} from './support.ts';

export function authRoutes(app: App, ctx: Ctx) {
  const tags = ['Authentication'];

  app.post(
    '/v1/auth/register',
    {
      config: strict(10),
      schema: { tags, summary: 'Register and send a verification code', body: registerSchema },
    },
    async (request, reply) => {
      const { nonce } = await accounts.register(ctx, request.body, metaOf(request));
      reply.setCookie(COOKIES.pending, nonce, cookieOptions(ctx, 'pending', 24 * 3600));
      return reply.status(202).send({ email: request.body.email });
    },
  );

  app.post(
    '/v1/auth/resend-verification',
    { config: strict(3), schema: { tags, summary: 'Send another verification code', body: emailOnlySchema } },
    async (request, reply) => {
      await accounts.resendVerification(ctx, request.body.email);
      return reply.status(202).send(OK);
    },
  );

  app.post(
    '/v1/auth/verify-email',
    {
      config: strict(10),
      schema: { tags, summary: 'Verify an email with a link token or code', body: verifyEmailSchema },
    },
    async (request, reply) => {
      const outcome = await accounts.verifyEmail(
        ctx,
        request.body,
        request.cookies[COOKIES.pending],
        metaOf(request),
      );
      reply.clearCookie(COOKIES.pending, { path: '/' });
      if (outcome.next === 'set_password') return { next: outcome.next, token: outcome.token };
      setSessionCookie(ctx, reply, 'user', outcome.session);
      return { next: outcome.next };
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: strict(10),
      schema: {
        tags,
        summary: 'Sign in',
        body: loginSchema.extend({ remember: z.boolean().default(false) }),
      },
    },
    async (request, reply) => {
      const { user, session } = await accounts.login(ctx, request.body, metaOf(request));
      setSessionCookie(ctx, reply, 'user', session);
      return accounts.publicUser(user);
    },
  );

  app.post(
    '/v1/auth/logout',
    { schema: { tags, summary: 'Sign out' }, preHandler: requireUser(ctx) },
    async (request, reply) => {
      await revokeSession(ctx, ctx.db, sessionOf(request));
      await audit(ctx.db, {
        actor: { type: 'user', id: userOf(request).id },
        userId: userOf(request).id,
        action: 'logout',
        meta: metaOf(request),
      });
      reply.clearCookie(COOKIES.user, { path: '/' });
      return OK;
    },
  );

  app.post(
    '/v1/auth/forgot-password',
    { config: strict(3), schema: { tags, summary: 'Email a password reset link', body: emailOnlySchema } },
    async (request, reply) => {
      const [user] = await ctx.db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.email, request.body.email));
      await accounts.forgotPassword(ctx, request.body.email, 'user', user?.status === 'active');
      return reply.status(202).send(OK);
    },
  );

  app.post(
    '/v1/auth/reset-password',
    {
      config: strict(5),
      schema: { tags, summary: 'Set a new password from a reset link', body: resetPasswordSchema },
    },
    async (request) => {
      await accounts.resetPassword(ctx, request.body.token, request.body.password, metaOf(request));
      return OK;
    },
  );

  app.get(
    '/v1/auth/session',
    { schema: { tags, summary: 'Current person, or null when signed out' } },
    async (request) => {
      const token = request.cookies[COOKIES.user];
      const found = token ? await userFromToken(ctx, token) : null;
      return { user: found ? accounts.publicUser(found.user) : null };
    },
  );
}
