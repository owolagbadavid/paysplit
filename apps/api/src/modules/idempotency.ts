import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { idempotencyKeys } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict } from '../lib/errors.ts';

/**
 * Runs `work` once per key and person. A repeat returns the first answer; the same key with a different request
 * is refused. The key row is written in the same transaction as the work, so a concurrent repeat waits for the
 * first to commit, and a rolled-back attempt frees the key.
 */
export async function withIdempotency<T>(
  tx: Tx,
  userId: string,
  key: string,
  request: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const requestHash = sha256(JSON.stringify(request));
  const [claimed] = await tx
    .insert(idempotencyKeys)
    .values({ userId, key, requestHash })
    .onConflictDoNothing()
    .returning();
  const mine = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
  if (!claimed) {
    const [existing] = await tx.select().from(idempotencyKeys).where(mine);
    if (!existing || existing.requestHash !== requestHash) {
      throw conflict('idempotency_key_reused', 'This request key was already used for something else');
    }
    return existing.response as T;
  }
  const response = await work();
  await tx.update(idempotencyKeys).set({ response }).where(mine);
  return response;
}
