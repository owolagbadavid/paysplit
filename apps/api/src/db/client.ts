import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.ts';

export type Database = ReturnType<typeof createDatabase>['db'];
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything a query can run on: the pool or an open transaction. */
export type Executor = Database | Tx;

export function createDatabase(url: string, ssl = false) {
  // prepare:false keeps this working behind Supabase's transaction-mode pooler.
  const client = postgres(url, { max: 10, prepare: false, ssl: ssl ? 'require' : false, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}
