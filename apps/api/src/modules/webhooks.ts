import { eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { transferAttempts, webhookEvents } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import type { PaymentEvent } from '../ports/payments.ts';
import { enqueue } from './jobs.ts';
import { creditPayIn } from './salary-payments.ts';
import { applyResult } from './transfers.ts';

/**
 * Accepts a signed provider event: verify, store, queue, answer. A repeat delivery of the same body only raises a
 * counter. Only the reference is kept from the body, because it can carry personal and card details.
 */
export async function receivePaymentWebhook(
  ctx: Ctx,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const event = ctx.payments.parseWebhook(rawBody, headers);
  await ctx.db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(webhookEvents)
      .values({
        provider: ctx.payments.name,
        eventKey: `${ctx.payments.name}:${sha256(rawBody)}`,
        eventType: event.type,
        reference: event.reference ?? null,
        payload: event,
        status: event.kind === 'ignored' ? 'ignored' : 'received',
      })
      .onConflictDoUpdate({
        target: webhookEvents.eventKey,
        set: { deliveries: sql`${webhookEvents.deliveries} + 1` },
      })
      .returning({ id: webhookEvents.id, deliveries: webhookEvents.deliveries });
    if (event.kind !== 'ignored' && stored!.deliveries === 1)
      await enqueue(tx, 'webhook.process', { webhookId: stored!.id });
  });
}

/** Asks the provider for the truth about the event's reference and applies that, so order does not matter. */
export async function processWebhook(ctx: Ctx, webhookId: string): Promise<void> {
  const [row] = await ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId));
  if (!row || row.status === 'processed') return;
  const event = row.payload as PaymentEvent;
  if (event.kind === 'payin') {
    await creditPayIn(ctx, await ctx.payments.getPayIn(event.reference));
  } else if (event.kind === 'transfer') {
    const [ours] = await ctx.db
      .select({ id: transferAttempts.id })
      .from(transferAttempts)
      .where(eq(transferAttempts.reference, event.reference));
    // Other software may share the provider account, so a transfer we never made is not ours to track.
    if (ours) await applyResult(ctx, event.reference, await ctx.payments.getTransfer(event.reference));
  }
  await ctx.db
    .update(webhookEvents)
    .set({ status: 'processed', processedAt: ctx.now() })
    .where(eq(webhookEvents.id, webhookId));
}
