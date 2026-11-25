import type { Executor } from '../db/client.ts';
import { auditLogs } from '../db/schema.ts';

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuditEvent {
  actor: { type: 'user' | 'admin' | 'system'; id?: string };
  action: string;
  /** Customer the event concerns, so it shows in their security activity. */
  userId?: string | undefined;
  target?: { type: string; id: string };
  metadata?: Record<string, unknown>;
  meta?: RequestMeta | undefined;
}

/** Appends to the audit log. Pass the open transaction so the record commits with the change it describes. */
export async function audit(ex: Executor, event: AuditEvent): Promise<void> {
  await ex.insert(auditLogs).values({
    actorType: event.actor.type,
    actorId: event.actor.id ?? null,
    userId: event.userId ?? null,
    action: event.action,
    targetType: event.target?.type ?? null,
    targetId: event.target?.id ?? null,
    metadata: event.metadata ?? {},
    ip: event.meta?.ip ?? null,
    userAgent: event.meta?.userAgent?.slice(0, 300) ?? null,
  });
}
