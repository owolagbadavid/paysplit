import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public address of the web app. Used in email links and as the only accepted browser origin. */
  APP_URL: z.url().default('http://localhost:5173'),
  /** Proxies in front of the app in production. Coolify's is one; Cloudflare's proxy in front of it makes two. */
  PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Directory of the built web app. When set, the API also serves it, so one origin covers everything. */
  WEB_DIST: z.string().optional(),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5544/paysplit'),
  DATABASE_SSL: flag.default(false),

  SUPABASE_AUTH_URL: z.url().default('http://localhost:9999'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  /** 32 random bytes, base64. Encrypts account numbers and short-lived identity numbers at rest. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes in base64'),
  /** Keys the fingerprints that detect reuse of an identity or bank account without storing it. */
  FINGERPRINT_KEY: z.string().min(32),
  /** Lets an external scheduler wake the service through POST /internal/tick. */
  CRON_SECRET: z.string().min(16),

  /** Which payment adapter runs. Only its keys are required. */
  PAYMENT_PROVIDER: z.enum(['paystack', 'flutterwave']).default('paystack'),

  PAYSTACK_SECRET_KEY: z.string().startsWith('sk_test_', 'must be a Paystack TEST secret key').optional(),
  PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),
  PAYSTACK_DVA_BANK: z.string().default('test-bank'),
  PAYSTACK_TIMEOUT_MS: z.coerce.number().default(20_000),

  FLUTTERWAVE_SECRET_KEY: z
    .string()
    .startsWith('FLWSECK_TEST-', 'must be a Flutterwave TEST secret key')
    .optional(),
  /** The secret hash typed into the Flutterwave dashboard, which every webhook repeats. */
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(32).optional(),
  FLUTTERWAVE_BASE_URL: z.url().default('https://api.flutterwave.com/v3'),
  FLUTTERWAVE_TIMEOUT_MS: z.coerce.number().default(20_000),

  DOJAH_APP_ID: z.string().min(1),
  DOJAH_SECRET_KEY: z.string().min(1),
  DOJAH_BASE_URL: z.url().default('https://sandbox.dojah.io'),
  DOJAH_WEBHOOK_SECRET: z.string().optional(),
  KYC_MATCH_THRESHOLD: z.coerce.number().min(50).max(100).default(70),
  KYC_LIVENESS_THRESHOLD: z.coerce.number().min(0).max(100).default(50),

  EMAIL_FROM: z.string().default('PaySplit <no-reply@paysplit.local>'),
  SMTP_URL: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  RATE_LIMITS: flag.default(true),
  WORKER: flag.default(true),
});

export type Config = z.infer<typeof envSchema> & {
  isProduction: boolean;
  kycSandbox: boolean;
  emulated: boolean;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/**
 * Reads and validates the environment. Refuses to start in production against a local emulator, so a deployed
 * PaySplit always talks to the real provider sandboxes.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';
  const missing =
    value.PAYMENT_PROVIDER === 'paystack'
      ? !value.PAYSTACK_SECRET_KEY && 'PAYSTACK_SECRET_KEY'
      : !value.FLUTTERWAVE_SECRET_KEY
        ? 'FLUTTERWAVE_SECRET_KEY'
        : !value.FLUTTERWAVE_WEBHOOK_HASH && 'FLUTTERWAVE_WEBHOOK_HASH';
  if (missing) throw new Error(`PAYMENT_PROVIDER=${value.PAYMENT_PROVIDER} needs ${missing}`);
  const paymentUrl =
    value.PAYMENT_PROVIDER === 'paystack' ? value.PAYSTACK_BASE_URL : value.FLUTTERWAVE_BASE_URL;
  const hosts = [paymentUrl, value.DOJAH_BASE_URL].map((u) => new URL(u).hostname);
  const emulated = hosts.some((h) => LOOPBACK.has(h));
  if (isProduction && emulated)
    throw new Error('Production cannot use a provider emulator. Set the real sandbox URLs.');
  if (isProduction && !value.BREVO_API_KEY && !value.SMTP_URL)
    throw new Error('Set BREVO_API_KEY or SMTP_URL.');
  return { ...value, isProduction, emulated, kycSandbox: emulated || hosts[1] === 'sandbox.dojah.io' };
}
