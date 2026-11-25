export const WALLET_CATEGORIES = [
  'savings',
  'emergency',
  'rent',
  'bills',
  'education',
  'travel',
  'investment',
  'other',
] as const;
export const BENEFICIARY_CATEGORIES = [
  'family',
  'personal',
  'rent',
  'utilities',
  'education',
  'bills',
  'other',
] as const;

/** Accent colours offered when creating a wallet. */
export const WALLET_ACCENTS = ['green', 'orange', 'purple', 'blue', 'teal', 'pink'] as const;
export type WalletAccent = (typeof WALLET_ACCENTS)[number];

export type IdentityField = { name: string; label: string; digits?: number };

export interface CountryConfig {
  code: string;
  name: string;
  dialCode: string;
  currency: string;
  timezone: string;
  /** Whether PaySplit can verify people and hold money here. Other countries may register and configure. */
  launched: boolean;
  identityOptions: IdentityField[];
}

/** Supported countries. Adding a market means adding a row here and a verification adapter for it. */
export const COUNTRIES: readonly CountryConfig[] = [
  {
    code: 'NG',
    name: 'Nigeria',
    dialCode: '+234',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    launched: true,
    identityOptions: [
      { name: 'bvn', label: 'Bank Verification Number (BVN)', digits: 11 },
      { name: 'nin', label: 'National Identification Number (NIN)', digits: 11 },
    ],
  },
  {
    code: 'GH',
    name: 'Ghana',
    dialCode: '+233',
    currency: 'GHS',
    timezone: 'Africa/Accra',
    launched: false,
    identityOptions: [],
  },
  {
    code: 'KE',
    name: 'Kenya',
    dialCode: '+254',
    currency: 'KES',
    timezone: 'Africa/Nairobi',
    launched: false,
    identityOptions: [],
  },
  {
    code: 'ZA',
    name: 'South Africa',
    dialCode: '+27',
    currency: 'ZAR',
    timezone: 'Africa/Johannesburg',
    launched: false,
    identityOptions: [],
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    dialCode: '+44',
    currency: 'GBP',
    timezone: 'Europe/London',
    launched: false,
    identityOptions: [],
  },
  {
    code: 'US',
    name: 'United States',
    dialCode: '+1',
    currency: 'USD',
    timezone: 'America/New_York',
    launched: false,
    identityOptions: [],
  },
];

export function country(code: string | null | undefined): CountryConfig | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

export const KYC_STATUSES = [
  'not_started',
  'in_progress',
  'pending_review',
  'action_required',
  'approved',
  'rejected',
  'reverification_required',
] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const TRANSACTION_TYPES = [
  'salary_received',
  'wallet_allocation',
  'beneficiary_transfer',
  'wallet_to_salary',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['pending', 'retrying', 'success', 'failed', 'reversed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Limits per verification tier, in minor units. Unverified users may configure but move nothing. */
export const TIER_LIMITS = {
  unverified: { singleTransfer: 0n, dailyTransfer: 0n },
  verified: { singleTransfer: 500_000_000n, dailyTransfer: 2_000_000_000n },
} as const;

export const SKIP_REASON_TEXT: Record<string, string> = {
  insufficient_funds: 'Skipped: insufficient funds',
  amount_rounds_to_zero: 'Skipped: the amount rounds down to zero',
  limit_exceeded: 'Skipped: above your transfer limit',
  destination_unavailable: 'Skipped: the destination is no longer available',
  already_allocated: 'Skipped: already allocated from this salary payment',
};
