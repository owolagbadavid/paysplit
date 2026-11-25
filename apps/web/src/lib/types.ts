/** Shapes the API returns. Amounts are kobo, percentages are basis points, dates are ISO strings. */

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string | null;
  countryName: string | null;
  phone: string | null;
  timezone: string;
  employer: string | null;
  expectedSalary: number | null;
  salaryDay: number | null;
  kycStatus: KycStatus;
  tier: number;
  notificationPrefs: Prefs;
  passwordChangedAt: string;
  createdAt: string;
}

export interface Prefs {
  salary_received: boolean;
  split_executed: boolean;
  disbursement_receipt: boolean;
  upcoming_split: boolean;
  monthly_summary: boolean;
}

export type KycStatus =
  | 'not_started'
  | 'in_progress'
  | 'pending_review'
  | 'action_required'
  | 'approved'
  | 'rejected'
  | 'reverification_required';

export interface Kyc {
  status: KycStatus;
  step: 'profile' | 'identity' | 'liveness' | 'done' | 'unsupported' | 'review';
  country: string | null;
  identityOptions: { name: 'bvn' | 'nin'; label: string; digits?: number }[];
  reason: string | null;
  attemptsLeft: number;
  identity: { type: string; last4: string; status: string; checkedAt: string | null } | null;
  liveness: { status: string; checkedAt: string | null } | null;
}

export interface SalaryAccount {
  status: 'provisioning' | 'active' | 'failed';
  accountNumber: string | null;
  accountName: string | null;
  bankName: string | null;
  failureReason: string | null;
  balance: number;
}

export interface Wallet {
  id: string;
  name: string;
  category: string;
  accent: string;
  description: string | null;
  targetAmount: number | null;
  balance: number;
  status: string;
  createdAt: string;
}

export interface LinkedRule {
  id: string;
  name: string;
  method: 'fixed' | 'percentage';
  value: number;
  priority: number;
  status: string;
  updatedAt: string;
}

export interface WalletDetail extends Wallet {
  totalAllocated: number;
  totalMoved: number;
  rule: LinkedRule | null;
}

export interface Beneficiary {
  id: string;
  name: string;
  category: string;
  bankCode: string;
  bankName: string;
  accountNumberMasked: string;
  accountName: string;
  narration: string | null;
  createdAt: string;
  rule?: { id: string; status: string } | null;
}

export interface BeneficiaryDetail extends Omit<Beneficiary, 'rule'> {
  accountNumber: string | null;
  totalSent: number;
  rule: LinkedRule | null;
}

export interface Rule {
  id: string;
  name: string;
  method: 'fixed' | 'percentage';
  value: number;
  priority: number;
  status: 'draft' | 'active' | 'paused';
  destination: { type: 'wallet' | 'beneficiary'; id: string; name: string; detail: string; category: string };
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  allocatedThisMonth: number;
}

export interface RuleDetail extends Rule {
  history: {
    executionId: string;
    executionReference: string;
    trigger: string;
    requested: number;
    allocated: number;
    status: string;
    skipReason: string | null;
    createdAt: string;
  }[];
}

export interface RulesOverview {
  baseline: { amount: number; source: 'last_salary' | 'expected' | null };
  projection: {
    totalAllocated: number;
    remainder: number;
    allocations: { ruleId: string; requested: number; allocated: number; skipReason: string | null }[];
  };
  rules: Rule[];
}

export interface Split {
  id: string;
  reference: string;
  salaryPaymentId: string;
  trigger: 'automatic' | 'manual';
  payCycle: string;
  status: 'pending' | 'successful' | 'partially_completed' | 'failed';
  salaryAmount: number;
  availableAmount: number;
  toWallets: number;
  toBeneficiaries: number;
  pending: number;
  skippedCount: number;
  failedCount: number;
  remaining: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SplitAllocation {
  id: string;
  ruleId: string;
  rule: {
    name: string;
    method: 'fixed' | 'percentage';
    value: number;
    priority: number;
    destinationType: string;
    destinationName: string;
    destinationDetail: string;
    category: string;
  };
  requested: number;
  allocated: number;
  availableBefore: number;
  status: string;
  skipReason: string | null;
  failureReason: string | null;
  attempts: number;
  transactionId: string | null;
  transactionReference: string | null;
}

export interface SplitDetail extends Split {
  salaryReference: string;
  allocations: SplitAllocation[];
}

export interface RunNowOption {
  salaryPaymentId: string;
  reference: string;
  paidAt: string;
  payCycle: string;
  salaryAmount: number;
  available: number;
  totalAllocated: number;
  remainder: number;
  planHash: string;
  allocations: {
    ruleId: string;
    ruleName: string;
    method: 'fixed' | 'percentage';
    value: number;
    priority: number;
    destination: { type: string; name: string; detail: string };
    requested: number;
    allocated: number;
    skipReason: string | null;
  }[];
}

export interface Transaction {
  id: string;
  reference: string;
  type: 'salary_received' | 'wallet_allocation' | 'beneficiary_transfer' | 'wallet_to_salary';
  status: 'pending' | 'retrying' | 'success' | 'failed' | 'reversed';
  amount: number;
  fee: number;
  description: string;
  category: string;
  source: { label: string; detail?: string };
  destination: { label: string; detail?: string };
  walletId: string | null;
  beneficiaryId: string | null;
  executionId: string | null;
  providerReference: string | null;
  failureReason: string | null;
  isTest: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface TransactionDetail extends Transaction {
  execution: { id: string; reference: string; trigger: string } | null;
  rule: { id: string; name: string; deleted: boolean } | null;
  hasReceipt: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Dashboard {
  account: SalaryAccount | null;
  period: { month: string; salaryReceived: number; allocated: number };
  walletTotal: number;
  wallets: Wallet[];
  targetWallets: number;
  activeRules: number;
  expected: { date: string; awaited: boolean } | null;
  months: { month: string; salary: number; wallets: number; beneficiaries: number }[];
  partition: {
    salary: number;
    payCycle: string;
    wallets: number;
    beneficiaries: number;
    pending: number;
    remaining: number;
  } | null;
  recentSplits: Split[];
  recentTransactions: Transaction[];
  runNowAvailable: boolean;
  setup: {
    emailVerified: boolean;
    profile: boolean;
    kyc: boolean;
    income: boolean;
    destination: boolean;
    rule: boolean;
    percent: number;
  };
  setupSkipped: boolean;
}

export interface Notification {
  id: string;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface Admin {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  passwordChangedAt: string;
  createdAt: string;
}

export interface AdminOverview {
  totalUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
  pendingVerification: number;
  totalSalaryPaid: number;
  paidUsers: number;
  openIssues: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  country: string | null;
  emailVerified: boolean;
  kycStatus: KycStatus;
  salaryDay: number | null;
  expectedSalary: number | null;
  accountBank: string | null;
  accountMasked: string | null;
  totalPaid: number;
  lastSalary: number | null;
  createdAt: string;
  ineligibleReason: string | null;
}

export interface AdminUserDetail {
  profile: User & { emailVerified: boolean };
  kyc: {
    identityType: string;
    identityMasked: string;
    identityStatus: string;
    identityCheckedAt: string | null;
    livenessStatus: string;
    livenessCheckedAt: string | null;
    livenessScore: number | null;
    matchScore: number | null;
    inReview: boolean;
    provider: string;
    reason: string | null;
  } | null;
  account: SalaryAccount | null;
  wallets: Wallet[];
  beneficiaries: Beneficiary[];
  rules: Rule[];
  splits: Split[];
  ineligibleReason: string | null;
  suggestedPayCycle: string;
}

export interface SalaryTransaction {
  id: string;
  reference: string;
  userId: string;
  userName: string;
  userEmail: string;
  amount: number;
  payCycle: string;
  source: 'admin_test' | 'bank_transfer';
  splitState: string;
  executionStatus: Split['status'] | null;
  paidAt: string;
}

export interface SalaryTransactionDetail extends Omit<SalaryTransaction, 'executionStatus'> {
  providerFee: number;
  provider: string;
  providerReference: string;
  channel: string;
  confirmedAt: string;
  executions: SplitDetail[];
}

export interface PayInRow {
  id: string;
  userId: string;
  userName: string;
  adminName: string;
  amount: number;
  confirmedAmount: number | null;
  payCycle: string;
  status: 'submitting' | 'awaiting_confirmation' | 'confirmed' | 'failed';
  splitState: string | null;
  executionStatus: Split['status'] | null;
  providerReference: string;
  failureReason: string | null;
  createdAt: string;
}

export interface PayIn extends Omit<PayInRow, 'executionStatus'> {
  provider: string;
  salaryPaymentId: string | null;
  execution: SplitDetail | null;
}

export interface Issue {
  id: string;
  kind: string;
  severity: 'info' | 'high' | 'critical';
  subject: string;
  detail: string;
  status: 'open' | 'resolved';
  occurrences: number;
  updatedAt: string;
}

export interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  createdAt: string;
}
