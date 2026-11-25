import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { NotificationPrefs } from '@paysplit/core';

/**
 * Everything lives in its own schema. Supabase exposes `public` through its REST API, so keeping PaySplit's
 * tables out of it means the anonymous key can never read them.
 */
export const ps = pgSchema('paysplit');

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const at = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => bigint(name, { mode: 'bigint' });

export const users = ps.table(
  'users',
  {
    id: id(),
    authId: uuid('auth_id').notNull().unique(),
    email: text('email').notNull().unique(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    emailVerifiedAt: at('email_verified_at'),
    /** Hash of the cookie given to the browser that registered, so verification from elsewhere is noticed. */
    pendingNonceHash: text('pending_nonce_hash'),
    country: text('country'),
    phone: text('phone'),
    timezone: text('timezone').notNull().default('Africa/Lagos'),
    employer: text('employer'),
    expectedSalary: money('expected_salary'),
    salaryDay: smallint('salary_day'),
    kycStatus: text('kyc_status').notNull().default('not_started'),
    status: text('status').notNull().default('active'),
    notificationPrefs: jsonb('notification_prefs').$type<NotificationPrefs>().notNull(),
    setupSkippedAt: at('setup_skipped_at'),
    passwordChangedAt: at('password_changed_at').notNull().defaultNow(),
    closedAt: at('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_salary_day', sql`${t.salaryDay} between 1 and 31`),
    check('users_status', sql`${t.status} in ('active','closed')`),
  ],
);

export const admins = ps.table('admins', {
  id: id(),
  authId: uuid('auth_id').notNull().unique(),
  email: text('email').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  phone: text('phone'),
  status: text('status').notNull().default('active'),
  passwordChangedAt: at('password_changed_at').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = ps.table(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id').references(() => users.id),
    adminId: uuid('admin_id').references(() => admins.id),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (t) => [
    check('sessions_one_actor', sql`num_nonnulls(${t.userId}, ${t.adminId}) = 1`),
    index('sessions_user').on(t.userId),
  ],
);

export const kycCases = ps.table(
  'kyc_cases',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    country: text('country').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('in_progress'),
    identityType: text('identity_type').notNull(),
    identityLast4: text('identity_last4').notNull(),
    identityFingerprint: text('identity_fingerprint').notNull(),
    /** Encrypted, kept only between the identity and liveness steps, then erased. */
    identityNumberEnc: text('identity_number_enc'),
    identityStatus: text('identity_status').notNull().default('pending'),
    identityCheckedAt: at('identity_checked_at'),
    nameMatch: boolean('name_match'),
    livenessStatus: text('liveness_status').notNull().default('pending'),
    livenessCheckedAt: at('liveness_checked_at'),
    livenessAttempts: integer('liveness_attempts').notNull().default(0),
    livenessScore: integer('liveness_score'),
    matchScore: integer('match_score'),
    reason: text('reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('kyc_cases_user').on(t.userId),
    uniqueIndex('kyc_cases_one_open')
      .on(t.userId)
      .where(sql`status in ('in_progress','pending_review','action_required','approved')`),
    check(
      'kyc_number_erased',
      sql`${t.identityNumberEnc} is null or ${t.status} in ('in_progress','action_required')`,
    ),
  ],
);

export const ledgerAccounts = ps.table(
  'ledger_accounts',
  {
    id: id(),
    code: text('code').notNull().unique(),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    currency: text('currency').notNull().default('NGN'),
    userId: uuid('user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('ledger_accounts_kind', sql`${t.kind} in ('asset','liability','expense')`),
    index('ledger_accounts_user').on(t.userId),
  ],
);

export const salaryAccounts = ps.table(
  'salary_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    ledgerAccountId: uuid('ledger_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('provisioning'),
    providerCustomerCode: text('provider_customer_code'),
    providerAccountId: text('provider_account_id'),
    /** Not unique: Flutterwave gives every test account the same number. */
    accountNumber: text('account_number'),
    accountName: text('account_name'),
    bankName: text('bank_name'),
    failureReason: text('failure_reason'),
    activatedAt: at('activated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('salary_accounts_provider_account').on(t.provider, t.providerAccountId),
    uniqueIndex('salary_accounts_provider_customer').on(t.provider, t.providerCustomerCode),
  ],
);

export const wallets = ps.table(
  'wallets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    ledgerAccountId: uuid('ledger_account_id')
      .notNull()
      .unique()
      .references(() => ledgerAccounts.id),
    name: text('name').notNull(),
    category: text('category').notNull(),
    accent: text('accent').notNull().default('blue'),
    targetAmount: money('target_amount'),
    description: text('description'),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wallets_name')
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`status = 'active'`),
    check('wallets_target', sql`${t.targetAmount} is null or ${t.targetAmount} > 0`),
  ],
);

export const beneficiaries = ps.table(
  'beneficiaries',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    category: text('category').notNull(),
    bankCode: text('bank_code').notNull(),
    bankName: text('bank_name').notNull(),
    accountNumberEnc: text('account_number_enc').notNull(),
    accountLast4: text('account_last4').notNull(),
    accountFingerprint: text('account_fingerprint').notNull(),
    accountName: text('account_name').notNull(),
    narration: text('narration'),
    recipientCode: text('recipient_code').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('beneficiaries_account')
      .on(t.userId, t.accountFingerprint)
      .where(sql`status = 'active'`),
  ],
);

export const rules = ps.table(
  'rules',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    walletId: uuid('wallet_id').references(() => wallets.id),
    beneficiaryId: uuid('beneficiary_id').references(() => beneficiaries.id),
    method: text('method').$type<'fixed' | 'percentage'>().notNull(),
    value: money('value').notNull(),
    priority: smallint('priority').notNull(),
    status: text('status').notNull().default('draft'),
    activatedAt: at('activated_at'),
    deletedAt: at('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('rules_user').on(t.userId),
    uniqueIndex('rules_one_per_wallet')
      .on(t.walletId)
      .where(sql`status <> 'deleted'`),
    uniqueIndex('rules_one_per_beneficiary')
      .on(t.beneficiaryId)
      .where(sql`status <> 'deleted'`),
    check('rules_one_destination', sql`num_nonnulls(${t.walletId}, ${t.beneficiaryId}) = 1`),
    check('rules_method', sql`${t.method} in ('fixed','percentage')`),
    check('rules_value', sql`${t.value} > 0 and (${t.method} = 'fixed' or ${t.value} <= 10000)`),
    check('rules_priority', sql`${t.priority} between 1 and 10`),
    check('rules_status', sql`${t.status} in ('draft','active','paused','deleted')`),
  ],
);

export const payinRuns = ps.table('payin_runs', {
  id: id(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => admins.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: money('amount').notNull(),
  payCycle: text('pay_cycle').notNull(),
  provider: text('provider').notNull(),
  providerReference: text('provider_reference').notNull().unique(),
  status: text('status').notNull().default('submitting'),
  failureReason: text('failure_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const salaryPayments = ps.table(
  'salary_payments',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    salaryAccountId: uuid('salary_account_id')
      .notNull()
      .references(() => salaryAccounts.id),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').notNull(),
    amount: money('amount').notNull(),
    providerFee: money('provider_fee')
      .notNull()
      .default(sql`0`),
    currency: text('currency').notNull().default('NGN'),
    channel: text('channel').notNull(),
    senderName: text('sender_name'),
    senderBank: text('sender_bank'),
    source: text('source').notNull(),
    payinRunId: uuid('payin_run_id')
      .unique()
      .references(() => payinRuns.id),
    payCycle: text('pay_cycle').notNull(),
    /** awaiting, split, held (cycle already split), no_rules or not_eligible. */
    splitState: text('split_state').notNull().default('awaiting'),
    paidAt: at('paid_at').notNull(),
    confirmedAt: at('confirmed_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('salary_payments_provider_ref').on(t.provider, t.providerReference),
    index('salary_payments_user').on(t.userId, t.paidAt),
    check('salary_payments_amount', sql`${t.amount} > 0`),
  ],
);

export const executions = ps.table(
  'executions',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    salaryPaymentId: uuid('salary_payment_id')
      .notNull()
      .references(() => salaryPayments.id),
    trigger: text('trigger').$type<'automatic' | 'manual'>().notNull(),
    payCycle: text('pay_cycle').notNull(),
    status: text('status').notNull(),
    baseAmount: money('base_amount').notNull(),
    availableAmount: money('available_amount').notNull(),
    completedAt: at('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('executions_user').on(t.userId, t.createdAt),
    uniqueIndex('executions_auto_per_payment')
      .on(t.salaryPaymentId)
      .where(sql`trigger = 'automatic'`),
    uniqueIndex('executions_auto_per_cycle')
      .on(t.userId, t.payCycle)
      .where(sql`trigger = 'automatic'`),
  ],
);

export interface RuleSnapshot {
  name: string;
  method: 'fixed' | 'percentage';
  value: number;
  priority: number;
  destinationType: 'wallet' | 'beneficiary';
  destinationName: string;
  destinationDetail: string;
  category: string;
}

export const allocations = ps.table(
  'allocations',
  {
    id: id(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => executions.id),
    salaryPaymentId: uuid('salary_payment_id')
      .notNull()
      .references(() => salaryPayments.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id),
    walletId: uuid('wallet_id').references(() => wallets.id),
    beneficiaryId: uuid('beneficiary_id').references(() => beneficiaries.id),
    /** Wallet, or fingerprint of the bank account, so re-adding a beneficiary cannot be paid twice. */
    destinationKey: text('destination_key').notNull(),
    position: integer('position').notNull(),
    snapshot: jsonb('snapshot').$type<RuleSnapshot>().notNull(),
    requestedAmount: money('requested_amount').notNull(),
    allocatedAmount: money('allocated_amount').notNull(),
    availableBefore: money('available_before').notNull(),
    status: text('status').$type<'pending' | 'success' | 'failed' | 'skipped' | 'reversed'>().notNull(),
    skipReason: text('skip_reason'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('allocations_execution').on(t.executionId),
    index('allocations_payment').on(t.salaryPaymentId),
    index('allocations_rule').on(t.ruleId),
    uniqueIndex('allocations_once_per_destination')
      .on(t.salaryPaymentId, t.destinationKey)
      .where(sql`status in ('pending','success')`),
  ],
);

export interface PartyLabel {
  label: string;
  detail?: string | undefined;
}

export const transactions = ps.table(
  'transactions',
  {
    id: id(),
    reference: text('reference').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    status: text('status').notNull(),
    amount: money('amount').notNull(),
    fee: money('fee')
      .notNull()
      .default(sql`0`),
    currency: text('currency').notNull().default('NGN'),
    description: text('description').notNull(),
    category: text('category').notNull(),
    source: jsonb('source').$type<PartyLabel>().notNull(),
    destination: jsonb('destination').$type<PartyLabel>().notNull(),
    walletId: uuid('wallet_id').references(() => wallets.id),
    beneficiaryId: uuid('beneficiary_id').references(() => beneficiaries.id),
    ruleId: uuid('rule_id').references(() => rules.id),
    executionId: uuid('execution_id').references(() => executions.id),
    allocationId: uuid('allocation_id')
      .unique()
      .references(() => allocations.id),
    salaryPaymentId: uuid('salary_payment_id').references(() => salaryPayments.id),
    providerReference: text('provider_reference'),
    failureReason: text('failure_reason'),
    isTest: boolean('is_test').notNull().default(true),
    completedAt: at('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('transactions_user').on(t.userId, t.createdAt),
    index('transactions_wallet').on(t.walletId),
    index('transactions_beneficiary').on(t.beneficiaryId),
    check('transactions_amount', sql`${t.amount} > 0`),
    check('transactions_status', sql`${t.status} in ('pending','retrying','success','failed','reversed')`),
  ],
);

export const ledgerJournals = ps.table('ledger_journals', {
  id: id(),
  /** Unique per business event, so posting the same event twice is refused by the database. */
  reference: text('reference').notNull().unique(),
  type: text('type').notNull(),
  description: text('description').notNull(),
  currency: text('currency').notNull().default('NGN'),
  transactionId: uuid('transaction_id').references(() => transactions.id),
  reversesJournalId: uuid('reverses_journal_id')
    .unique()
    .references((): AnyPgColumn => ledgerJournals.id),
  createdAt: createdAt(),
});

export const ledgerEntries = ps.table(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => ledgerJournals.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    direction: text('direction').$type<'debit' | 'credit'>().notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ledger_entries_amount', sql`${t.amount} > 0`),
    check('ledger_entries_direction', sql`${t.direction} in ('debit','credit')`),
    index('ledger_entries_account').on(t.accountId, t.createdAt),
    index('ledger_entries_journal').on(t.journalId),
  ],
);

export const transfers = ps.table(
  'transfers',
  {
    id: id(),
    allocationId: uuid('allocation_id')
      .notNull()
      .unique()
      .references(() => allocations.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    beneficiaryId: uuid('beneficiary_id')
      .notNull()
      .references(() => beneficiaries.id),
    recipientCode: text('recipient_code').notNull(),
    narration: text('narration').notNull(),
    amount: money('amount').notNull(),
    /** queued, in_flight, unknown, retrying, success, failed or reversed. */
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastCheckedAt: at('last_checked_at'),
    completedAt: at('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('transfers_open').on(t.status, t.updatedAt)],
);

export const transferAttempts = ps.table(
  'transfer_attempts',
  {
    id: id(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => transfers.id),
    attemptNo: integer('attempt_no').notNull(),
    /** Sent to the provider as its idempotency reference. */
    reference: text('reference').notNull().unique(),
    status: text('status').notNull().default('created'),
    /** Set before the first call leaves the building. Once set, resubmission requires a lookup first. */
    submittedAt: at('submitted_at'),
    providerCode: text('provider_code'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('transfer_attempts_no').on(t.transferId, t.attemptNo),
    uniqueIndex('transfer_attempts_one_live')
      .on(t.transferId)
      .where(sql`status not in ('failed','reversed')`),
  ],
);

export const webhookEvents = ps.table('webhook_events', {
  id: id(),
  provider: text('provider').notNull(),
  eventKey: text('event_key').notNull().unique(),
  eventType: text('event_type').notNull(),
  reference: text('reference'),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('received'),
  deliveries: integer('deliveries').notNull().default(1),
  error: text('error'),
  receivedAt: at('received_at').notNull().defaultNow(),
  processedAt: at('processed_at'),
});

export const jobs = ps.table(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    runAt: at('run_at').notNull().defaultNow(),
    lockedUntil: at('locked_until'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_due').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe')
      .on(t.dedupeKey)
      .where(sql`status = 'queued'`),
  ],
);

export const scheduledRuns = ps.table(
  'scheduled_runs',
  {
    task: text('task').notNull(),
    window: text('window').notNull(),
    startedAt: at('started_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scheduled_runs_once').on(t.task, t.window)],
);

export const idempotencyKeys = ps.table(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_keys_once').on(t.userId, t.key)],
);

export const notifications = ps.table(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    readAt: at('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user').on(t.userId, t.createdAt)],
);

export const emails = ps.table('emails', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  recipient: text('recipient').notNull(),
  template: text('template').notNull(),
  subject: text('subject').notNull(),
  /** Blanked once sent when it carried a code or link that grants access. */
  html: text('html').notNull(),
  text: text('text').notNull(),
  sensitive: boolean('sensitive').notNull().default(false),
  dedupeKey: text('dedupe_key').notNull().unique(),
  status: text('status').notNull().default('queued'),
  error: text('error'),
  sentAt: at('sent_at'),
  createdAt: createdAt(),
});

export const auditLogs = ps.table(
  'audit_logs',
  {
    id: id(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_user').on(t.userId, t.createdAt), index('audit_logs_time').on(t.createdAt)],
);

export const reconciliationIssues = ps.table(
  'reconciliation_issues',
  {
    id: id(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    subject: text('subject').notNull(),
    detail: text('detail').notNull(),
    status: text('status').notNull().default('open'),
    occurrences: integer('occurrences').notNull().default(1),
    resolvedAt: at('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_issues_open')
      .on(t.kind, t.subject)
      .where(sql`status = 'open'`),
  ],
);

export const bankCache = ps.table('bank_cache', {
  provider: text('provider').primaryKey(),
  banks: jsonb('banks').$type<{ code: string; name: string }[]>().notNull(),
  fetchedAt: at('fetched_at').notNull().defaultNow(),
});
