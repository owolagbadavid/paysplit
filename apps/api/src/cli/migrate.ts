import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../db/client.ts';

/** Applies pending migrations. Uses the direct connection string, not the pooled one, when both are set. */
const url =
  process.env.DIRECT_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5544/paysplit';
const { client, db } = createDatabase(url, process.env.DATABASE_SSL === 'true');
await migrate(db, {
  migrationsFolder: process.env.MIGRATIONS_DIR ?? './drizzle',
  migrationsSchema: 'paysplit_migrations',
});
await client.end();
console.log('Migrations applied');
