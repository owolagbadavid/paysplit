import { z } from 'zod';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import {
  BENEFICIARY_CATEGORIES,
  COUNTRIES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  WALLET_ACCENTS,
  WALLET_CATEGORIES,
} from './catalog.ts';
import { MAX_MINOR } from './money.ts';
import { PAY_CYCLE_PATTERN } from './cycle.ts';

export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 10 characters', test: (v: string) => v.length >= 10 },
  { id: 'upper', label: 'One uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { id: 'lower', label: 'One lowercase letter', test: (v: string) => /[a-z]/.test(v) },
  { id: 'number', label: 'One number', test: (v: string) => /\d/.test(v) },
] as const;

export const passwordSchema = z
  .string()
  .max(72, 'Use 72 characters or fewer')
  .superRefine((value, ctx) => {
    for (const rule of PASSWORD_RULES) {
      if (!rule.test(value))
        ctx.addIssue({ code: 'custom', message: `Password needs: ${rule.label.toLowerCase()}` });
    }
  });

const name = (label: string) =>
  z.string().trim().min(1, `Enter your ${label}`).max(60, 'Use 60 characters or fewer');
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));
export const amountSchema = z
  .int('Enter a valid amount')
  .positive('Enter an amount above zero')
  .max(MAX_MINOR);

export const registerSchema = z
  .object({
    firstName: name('first name'),
    lastName: name('last name'),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});
export const emailOnlySchema = z.object({ email: emailSchema });
export const verifyEmailSchema = z.union([
  z.object({ token: z.string().min(10).max(200) }),
  z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
]);
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

/** Returns the E.164 form of a phone number when it is valid for the country, otherwise null. */
export function normalizePhone(value: string, countryCode: string): string | null {
  const parsed = parsePhoneNumberFromString(value, countryCode as CountryCode);
  return parsed?.isValid() && parsed.country === countryCode ? parsed.number : null;
}

export const profileSchema = z
  .object({
    country: z.enum(COUNTRIES.map((c) => c.code) as [string, ...string[]]),
    phone: z.string().trim().min(5).max(24),
  })
  .superRefine((v, ctx) => {
    if (!normalizePhone(v.phone, v.country)) {
      ctx.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'Enter a valid phone number for the selected country',
      });
    }
  });

export const updateMeSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
  phone: z.string().trim().max(24).optional(),
});
/** Income details the user expects. They drive estimates only and never move money. */
export const incomeSchema = z.object({
  employer: z.string().trim().max(80).nullish(),
  expectedSalary: amountSchema.nullish(),
  salaryDay: z.int().min(1, 'Choose a day').max(31),
});

export const NOTIFICATION_PREFS = [
  'salary_received',
  'split_executed',
  'disbursement_receipt',
  'upcoming_split',
  'monthly_summary',
] as const;
export const notificationPrefsSchema = z.object({
  salary_received: z.boolean(),
  split_executed: z.boolean(),
  disbursement_receipt: z.boolean(),
  upcoming_split: z.boolean(),
  monthly_summary: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export const DEFAULT_PREFS: NotificationPrefs = {
  salary_received: true,
  split_executed: true,
  disbursement_receipt: true,
  upcoming_split: true,
  monthly_summary: true,
};

export const identitySchema = z.object({
  type: z.enum(['bvn', 'nin']),
  number: z.string().regex(/^\d{11}$/, 'Enter all 11 digits'),
});
export const livenessSchema = z.object({
  /** JPEG as base64, with or without the data URL prefix. */
  image: z
    .string()
    .min(1000, 'The photo is too small. Try again in better light.')
    .max(3_000_000, 'The photo is too large'),
});

export const walletSchema = z.object({
  name: z.string().trim().min(1, 'Enter a wallet name').max(60),
  category: z.enum(WALLET_CATEGORIES, 'Choose a category'),
  accent: z.enum(WALLET_ACCENTS).default('blue'),
  targetAmount: amountSchema.nullish(),
  description: z.string().trim().max(200).nullish(),
});

export const moveSchema = z.object({ amount: amountSchema });

export const resolveAccountSchema = z.object({
  bankCode: z.string().min(1, 'Choose a bank').max(20),
  accountNumber: z.string().regex(/^\d{10}$/, 'Enter the 10-digit account number'),
});

export const beneficiarySchema = resolveAccountSchema.extend({
  name: z.string().trim().min(1, 'Enter a beneficiary name').max(80),
  category: z.enum(BENEFICIARY_CATEGORIES, 'Choose a category'),
  narration: z.string().trim().max(80).nullish(),
});

export const beneficiaryUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(BENEFICIARY_CATEGORIES),
  narration: z.string().trim().max(80).nullish(),
  /** Both or neither. Sending them re-validates the account with the provider. */
  bankCode: z.string().max(20).optional(),
  accountNumber: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
});

const ruleFields = {
  name: z.string().trim().min(1, 'Enter a rule name').max(60),
  method: z.enum(['fixed', 'percentage']),
  /** Kobo for fixed rules, basis points for percentage rules. */
  value: z.int().positive('Enter a value above zero').max(MAX_MINOR),
  priority: z.int().min(1).max(10),
};
const checkPercent = (v: { method: string; value: number }, ctx: z.RefinementCtx) => {
  if (v.method === 'percentage' && v.value > 10_000) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage cannot be above 100%' });
  }
};
export const ruleSchema = z
  .object({
    ...ruleFields,
    destinationType: z.enum(['wallet', 'beneficiary']),
    destinationId: z.uuid('Choose a destination'),
  })
  .superRefine(checkPercent);
export const ruleUpdateSchema = z.object(ruleFields).superRefine(checkPercent);

export const runNowSchema = z.object({
  salaryPaymentId: z.uuid(),
  /** Hash of the plan the user reviewed. A changed plan is refused so nobody confirms one thing and runs another. */
  planHash: z.string().length(64),
});

export const transactionFilterSchema = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  walletId: z.uuid().optional(),
  beneficiaryId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const statementSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  format: z.enum(['csv', 'pdf']),
  account: z.string().max(40).default('salary'),
});

export const closeAccountSchema = z.object({ password: z.string().min(1).max(200) });

export const adminProfileSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
  phone: z.string().trim().max(24).nullish(),
});
export const payinSchema = z.object({
  userId: z.uuid(),
  amount: amountSchema.min(10_000, 'The smallest test salary is ₦100'),
  payCycle: z.string().regex(PAY_CYCLE_PATTERN).optional(),
});

export const kycReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(5, 'Say why in a few words').max(300),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type WalletInput = z.infer<typeof walletSchema>;
export type IncomeInput = z.infer<typeof incomeSchema>;
export type BeneficiaryInput = z.infer<typeof beneficiarySchema>;
export type BeneficiaryUpdateInput = z.infer<typeof beneficiaryUpdateSchema>;
export type RuleInput = z.infer<typeof ruleSchema>;
export type RuleUpdateInput = z.infer<typeof ruleUpdateSchema>;
export type TransactionFilter = z.infer<typeof transactionFilterSchema>;
