import type { Logger } from 'pino';
import type { Config } from './config.ts';
import type { Database } from './db/client.ts';
import type { Vault } from './lib/crypto.ts';
import type { AuthProvider } from './ports/auth.ts';
import type { EmailSender } from './ports/email.ts';
import type { PaymentProvider } from './ports/payments.ts';
import type { RegionRouter } from './ports/verification.ts';

/** Everything a module may depend on. Tests build one with their own clock and provider endpoints. */
export interface Ctx {
  config: Config;
  db: Database;
  log: Logger;
  vault: Vault;
  payments: PaymentProvider;
  verification: RegionRouter;
  auth: AuthProvider;
  mailer: EmailSender;
  now: () => Date;
}
