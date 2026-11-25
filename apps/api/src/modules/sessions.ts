import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import type { Executor } from '../db/client.ts';
import { admins, sessions, users } from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import type { RequestMeta } from './audit.ts';

const HOUR = 3_600_000;
const LIFETIME = { user: 12 * HOUR, userRemembered: 30 * 24 * HOUR, admin: 8 * HOUR };

export type UserRow = typeof users.$inferSelect;
export type AdminRow = typeof admins.$inferSelect;

/** Opens a session and returns the cookie value. Only its hash is stored, so a database leak opens no account. */
export async function openSession(
  ctx: Ctx,
  ex: Executor,
  actor: { userId: string } | { adminId: string },
  options: { remember?: boolean; meta: RequestMeta },
): Promise<{ token: string; expiresAt: Date; maxAgeSeconds: number }> {
  const token = randomToken();
  const lifetime =
    'adminId' in actor ? LIFETIME.admin : options.remember ? LIFETIME.userRemembered : LIFETIME.user;
  const expiresAt = new Date(ctx.now().getTime() + lifetime);
  await ex.insert(sessions).values({
    tokenHash: sha256(token),
    ...actor,
    ip: options.meta.ip ?? null,
    userAgent: options.meta.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });
  return { token, expiresAt, maxAgeSeconds: Math.floor(lifetime / 1000) };
}

async function findSession(ctx: Ctx, token: string) {
  const [session] = await ctx.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, ctx.now()),
      ),
    );
  if (!session) return null;
  if (ctx.now().getTime() - session.lastSeenAt.getTime() > 60_000) {
    await ctx.db.update(sessions).set({ lastSeenAt: ctx.now() }).where(eq(sessions.id, session.id));
  }
  return session;
}

export async function userFromToken(
  ctx: Ctx,
  token: string,
): Promise<{ user: UserRow; sessionId: string } | null> {
  const session = await findSession(ctx, token);
  if (!session?.userId) return null;
  const [user] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.status, 'active')));
  return user ? { user, sessionId: session.id } : null;
}

export async function adminFromToken(
  ctx: Ctx,
  token: string,
): Promise<{ admin: AdminRow; sessionId: string } | null> {
  const session = await findSession(ctx, token);
  if (!session?.adminId) return null;
  const [admin] = await ctx.db
    .select()
    .from(admins)
    .where(and(eq(admins.id, session.adminId), eq(admins.status, 'active')));
  return admin ? { admin, sessionId: session.id } : null;
}

export async function revokeSession(ctx: Ctx, ex: Executor, sessionId: string): Promise<void> {
  await ex.update(sessions).set({ revokedAt: ctx.now() }).where(eq(sessions.id, sessionId));
}

export async function revokeAll(
  ctx: Ctx,
  ex: Executor,
  actor: { userId: string } | { adminId: string },
  exceptId?: string,
) {
  const owner = 'userId' in actor ? eq(sessions.userId, actor.userId) : eq(sessions.adminId, actor.adminId);
  await ex
    .update(sessions)
    .set({ revokedAt: ctx.now() })
    .where(and(owner, isNull(sessions.revokedAt), exceptId ? ne(sessions.id, exceptId) : undefined));
}

export function listSessions(ctx: Ctx, userId: string) {
  return ctx.db
    .select({
      id: sessions.id,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, ctx.now())))
    .orderBy(desc(sessions.lastSeenAt));
}

/** Whether this person has signed in with this browser before, to decide on a new-login alert. */
export async function isNewDevice(ctx: Ctx, userId: string, userAgent: string | undefined): Promise<boolean> {
  const known = await ctx.db
    .select({ userAgent: sessions.userAgent })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .limit(200);
  if (known.length === 0) return false;
  return !known.some((s) => s.userAgent === (userAgent?.slice(0, 300) ?? null));
}
