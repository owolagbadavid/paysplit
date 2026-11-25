import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyBaseLogger,
  RawServerDefault,
} from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { badRequest, unauthorized } from '../lib/errors.ts';
import type { RequestMeta } from '../modules/audit.ts';
import { adminFromToken, userFromToken, type AdminRow, type UserRow } from '../modules/sessions.ts';

export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export const COOKIES = { user: 'ps_session', admin: 'ps_admin', pending: 'ps_pending' } as const;

declare module 'fastify' {
  interface FastifyRequest {
    auth: { user?: UserRow; admin?: AdminRow; sessionId?: string };
  }
}

export const metaOf = (request: FastifyRequest): RequestMeta => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'],
});

export function cookieOptions(ctx: Ctx, kind: keyof typeof COOKIES, maxAge?: number) {
  return {
    httpOnly: true,
    secure: ctx.config.isProduction,
    sameSite: kind === 'admin' ? ('strict' as const) : ('lax' as const),
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

export function setSessionCookie(
  ctx: Ctx,
  reply: FastifyReply,
  kind: 'user' | 'admin',
  session: { token: string; maxAgeSeconds: number },
) {
  reply.setCookie(COOKIES[kind], session.token, cookieOptions(ctx, kind, session.maxAgeSeconds));
}

export const requireUser = (ctx: Ctx) => async (request: FastifyRequest) => {
  const token = request.cookies[COOKIES.user];
  const found = token ? await userFromToken(ctx, token) : null;
  if (!found) throw unauthorized();
  request.auth = found;
};

export const requireAdmin = (ctx: Ctx) => async (request: FastifyRequest) => {
  const token = request.cookies[COOKIES.admin];
  const found = token ? await adminFromToken(ctx, token) : null;
  if (!found) throw unauthorized('Sign in as an administrator');
  request.auth = found;
};

export const userOf = (request: FastifyRequest): UserRow => request.auth.user!;
export const adminOf = (request: FastifyRequest): AdminRow => request.auth.admin!;
export const sessionOf = (request: FastifyRequest): string => request.auth.sessionId!;

export function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\w-]{16,80}$/.test(key))
    throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header');
  return key;
}

export const idParams = z.object({ id: z.uuid() });
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});
export const OK = { ok: true } as const;

/** Tighter limit for endpoints worth abusing. */
export const strict = (max: number, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow } });
