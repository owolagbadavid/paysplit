import pino from 'pino';
import { BrevoSender, SmtpSender } from './adapters/email.ts';
import { DojahProvider } from './adapters/dojah.ts';
import { FlutterwaveProvider } from './adapters/flutterwave.ts';
import { PaystackProvider } from './adapters/paystack.ts';
import { SupabaseAuth } from './adapters/supabase-auth.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { createDatabase } from './db/client.ts';
import { Vault } from './lib/crypto.ts';
import type { PaymentProvider } from './ports/payments.ts';
import { RegionRouter } from './ports/verification.ts';

/** Structured logs without secrets: no cookies, no bodies, and no query strings, which can carry reset tokens. */
export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers', 'headers', '*.password', '*.token', '*.authorization'],
    serializers: {
      req: (req: { method: string; url: string; id: string; ip?: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
        ip: req.ip,
      }),
    },
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

function createPayments(config: Config): PaymentProvider {
  return config.PAYMENT_PROVIDER === 'flutterwave'
    ? new FlutterwaveProvider({
        secretKey: config.FLUTTERWAVE_SECRET_KEY!,
        webhookHash: config.FLUTTERWAVE_WEBHOOK_HASH!,
        baseUrl: config.FLUTTERWAVE_BASE_URL,
        timeoutMs: config.FLUTTERWAVE_TIMEOUT_MS,
      })
    : new PaystackProvider({
        secretKey: config.PAYSTACK_SECRET_KEY!,
        baseUrl: config.PAYSTACK_BASE_URL,
        dvaBank: config.PAYSTACK_DVA_BANK,
        timeoutMs: config.PAYSTACK_TIMEOUT_MS,
      });
}

/** Wires every port to its adapter. The only place that names a vendor. */
export function createContext(config: Config): { ctx: Ctx; close: () => Promise<void> } {
  const { client, db } = createDatabase(config.DATABASE_URL, config.DATABASE_SSL);
  const dojah = new DojahProvider({
    appId: config.DOJAH_APP_ID,
    secretKey: config.DOJAH_SECRET_KEY,
    baseUrl: config.DOJAH_BASE_URL,
    matchThreshold: config.KYC_MATCH_THRESHOLD,
    livenessThreshold: config.KYC_LIVENESS_THRESHOLD,
    fixedLiveness: new URL(config.DOJAH_BASE_URL).hostname === 'sandbox.dojah.io',
  });
  const ctx: Ctx = {
    config,
    db,
    log: createLogger(config),
    vault: new Vault(config.DATA_ENCRYPTION_KEY, config.FINGERPRINT_KEY),
    payments: createPayments(config),
    verification: new RegionRouter({ NG: dojah }),
    auth: new SupabaseAuth(config.SUPABASE_AUTH_URL, config.SUPABASE_SERVICE_ROLE_KEY),
    mailer: config.BREVO_API_KEY
      ? new BrevoSender(config.BREVO_API_KEY, config.EMAIL_FROM)
      : new SmtpSender(config.SMTP_URL ?? 'smtp://localhost:1026', config.EMAIL_FROM),
    now: () => new Date(),
  };
  return { ctx, close: () => client.end({ timeout: 5 }) };
}
