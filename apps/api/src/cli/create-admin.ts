import { eq } from 'drizzle-orm';
import { emailSchema, passwordSchema } from '@paysplit/core';
import { loadConfig } from '../config.ts';
import { createContext } from '../create-context.ts';
import { admins, users } from '../db/schema.ts';
import { audit } from '../modules/audit.ts';

/**
 * Creates an administrator. The password comes from ADMIN_PASSWORD so it never appears in shell history or a
 * process list: ADMIN_PASSWORD=... pnpm admin:create you@example.com First Last
 */
const [email, firstName, lastName] = process.argv.slice(2).filter((a) => a !== '--');
const password = process.env.ADMIN_PASSWORD;
if (!email || !firstName || !lastName || !password) {
  console.error('Usage: ADMIN_PASSWORD=... pnpm admin:create <email> <first name> <last name>');
  process.exit(1);
}
const { ctx, close } = createContext(loadConfig());
const address = emailSchema.parse(email);
passwordSchema.parse(password);
const [customer] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, address));
if (customer) throw new Error('That email belongs to a customer. Use a different one for the administrator.');
const { authId } = await ctx.auth.createVerifiedUser({ email: address, password });
const [admin] = await ctx.db
  .insert(admins)
  .values({ authId, email: address, firstName, lastName })
  .returning();
await audit(ctx.db, {
  actor: { type: 'system' },
  action: 'admin.created',
  target: { type: 'admin', id: admin!.id },
});
await close();
console.log(`Administrator ${address} created`);
