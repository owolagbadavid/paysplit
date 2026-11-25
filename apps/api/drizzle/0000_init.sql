CREATE SCHEMA "paysplit";
--> statement-breakpoint
CREATE TABLE "paysplit"."admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_auth_id_unique" UNIQUE("auth_id"),
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"salary_payment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"wallet_id" uuid,
	"beneficiary_id" uuid,
	"destination_key" text NOT NULL,
	"position" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"requested_amount" bigint NOT NULL,
	"allocated_amount" bigint NOT NULL,
	"available_before" bigint NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."bank_cache" (
	"provider" text PRIMARY KEY NOT NULL,
	"banks" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number_enc" text NOT NULL,
	"account_last4" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"account_name" text NOT NULL,
	"narration" text,
	"recipient_code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"recipient" text NOT NULL,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"salary_payment_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"pay_cycle" text NOT NULL,
	"status" text NOT NULL,
	"base_amount" bigint NOT NULL,
	"available_amount" bigint NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executions_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."kyc_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"country" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"identity_type" text NOT NULL,
	"identity_last4" text NOT NULL,
	"identity_fingerprint" text NOT NULL,
	"identity_number_enc" text,
	"identity_status" text DEFAULT 'pending' NOT NULL,
	"identity_checked_at" timestamp with time zone,
	"name_match" boolean,
	"liveness_status" text DEFAULT 'pending' NOT NULL,
	"liveness_checked_at" timestamp with time zone,
	"liveness_attempts" integer DEFAULT 0 NOT NULL,
	"liveness_score" integer,
	"match_score" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_number_erased" CHECK ("paysplit"."kyc_cases"."identity_number_enc" is null or "paysplit"."kyc_cases"."status" in ('in_progress','action_required'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "ledger_accounts_kind" CHECK ("paysplit"."ledger_accounts"."kind" in ('asset','liability','expense'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount" CHECK ("paysplit"."ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_entries_direction" CHECK ("paysplit"."ledger_entries"."direction" in ('debit','credit'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."ledger_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"transaction_id" uuid,
	"reverses_journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_journals_reference_unique" UNIQUE("reference"),
	CONSTRAINT "ledger_journals_reverses_journal_id_unique" UNIQUE("reverses_journal_id")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."payin_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"pay_cycle" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payin_runs_provider_reference_unique" UNIQUE("provider_reference")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"subject" text NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"wallet_id" uuid,
	"beneficiary_id" uuid,
	"method" text NOT NULL,
	"value" bigint NOT NULL,
	"priority" smallint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_one_destination" CHECK (num_nonnulls("paysplit"."rules"."wallet_id", "paysplit"."rules"."beneficiary_id") = 1),
	CONSTRAINT "rules_method" CHECK ("paysplit"."rules"."method" in ('fixed','percentage')),
	CONSTRAINT "rules_value" CHECK ("paysplit"."rules"."value" > 0 and ("paysplit"."rules"."method" = 'fixed' or "paysplit"."rules"."value" <= 10000)),
	CONSTRAINT "rules_priority" CHECK ("paysplit"."rules"."priority" between 1 and 10),
	CONSTRAINT "rules_status" CHECK ("paysplit"."rules"."status" in ('draft','active','paused','deleted'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."salary_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"provider_customer_code" text,
	"provider_account_id" text,
	"account_number" text,
	"account_name" text,
	"bank_name" text,
	"failure_reason" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "salary_accounts_account_number_unique" UNIQUE("account_number")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."salary_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"salary_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"amount" bigint NOT NULL,
	"provider_fee" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"channel" text NOT NULL,
	"sender_name" text,
	"sender_bank" text,
	"source" text NOT NULL,
	"payin_run_id" uuid,
	"pay_cycle" text NOT NULL,
	"split_state" text DEFAULT 'awaiting' NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_payments_reference_unique" UNIQUE("reference"),
	CONSTRAINT "salary_payments_payin_run_id_unique" UNIQUE("payin_run_id"),
	CONSTRAINT "salary_payments_amount" CHECK ("paysplit"."salary_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "paysplit"."scheduled_runs" (
	"task" text NOT NULL,
	"window" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paysplit"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"admin_id" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_one_actor" CHECK (num_nonnulls("paysplit"."sessions"."user_id", "paysplit"."sessions"."admin_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "paysplit"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"amount" bigint NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"source" jsonb NOT NULL,
	"destination" jsonb NOT NULL,
	"wallet_id" uuid,
	"beneficiary_id" uuid,
	"rule_id" uuid,
	"execution_id" uuid,
	"allocation_id" uuid,
	"salary_payment_id" uuid,
	"provider_reference" text,
	"failure_reason" text,
	"is_test" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_reference_unique" UNIQUE("reference"),
	CONSTRAINT "transactions_allocation_id_unique" UNIQUE("allocation_id"),
	CONSTRAINT "transactions_amount" CHECK ("paysplit"."transactions"."amount" > 0),
	CONSTRAINT "transactions_status" CHECK ("paysplit"."transactions"."status" in ('pending','retrying','success','failed','reversed'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."transfer_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"submitted_at" timestamp with time zone,
	"provider_code" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_attempts_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"beneficiary_id" uuid NOT NULL,
	"recipient_code" text NOT NULL,
	"narration" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_allocation_id_unique" UNIQUE("allocation_id"),
	CONSTRAINT "transfers_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
CREATE TABLE "paysplit"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"pending_nonce_hash" text,
	"country" text,
	"phone" text,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"employer" text,
	"expected_salary" bigint,
	"salary_day" smallint,
	"kyc_status" text DEFAULT 'not_started' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notification_prefs" jsonb NOT NULL,
	"setup_skipped_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_id_unique" UNIQUE("auth_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_salary_day" CHECK ("paysplit"."users"."salary_day" between 1 and 31),
	CONSTRAINT "users_status" CHECK ("paysplit"."users"."status" in ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE "paysplit"."wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"accent" text DEFAULT 'blue' NOT NULL,
	"target_amount" bigint,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_ledger_account_id_unique" UNIQUE("ledger_account_id"),
	CONSTRAINT "wallets_target" CHECK ("paysplit"."wallets"."target_amount" is null or "paysplit"."wallets"."target_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "paysplit"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"reference" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "paysplit"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_salary_payment_id_salary_payments_id_fk" FOREIGN KEY ("salary_payment_id") REFERENCES "paysplit"."salary_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "paysplit"."rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "paysplit"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."allocations" ADD CONSTRAINT "allocations_beneficiary_id_beneficiaries_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "paysplit"."beneficiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."beneficiaries" ADD CONSTRAINT "beneficiaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."emails" ADD CONSTRAINT "emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."executions" ADD CONSTRAINT "executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."executions" ADD CONSTRAINT "executions_salary_payment_id_salary_payments_id_fk" FOREIGN KEY ("salary_payment_id") REFERENCES "paysplit"."salary_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."kyc_cases" ADD CONSTRAINT "kyc_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "paysplit"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "paysplit"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."ledger_journals" ADD CONSTRAINT "ledger_journals_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "paysplit"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."ledger_journals" ADD CONSTRAINT "ledger_journals_reverses_journal_id_ledger_journals_id_fk" FOREIGN KEY ("reverses_journal_id") REFERENCES "paysplit"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."payin_runs" ADD CONSTRAINT "payin_runs_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "paysplit"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."payin_runs" ADD CONSTRAINT "payin_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."rules" ADD CONSTRAINT "rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."rules" ADD CONSTRAINT "rules_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "paysplit"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."rules" ADD CONSTRAINT "rules_beneficiary_id_beneficiaries_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "paysplit"."beneficiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."salary_accounts" ADD CONSTRAINT "salary_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."salary_accounts" ADD CONSTRAINT "salary_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "paysplit"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."salary_payments" ADD CONSTRAINT "salary_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."salary_payments" ADD CONSTRAINT "salary_payments_salary_account_id_salary_accounts_id_fk" FOREIGN KEY ("salary_account_id") REFERENCES "paysplit"."salary_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."salary_payments" ADD CONSTRAINT "salary_payments_payin_run_id_payin_runs_id_fk" FOREIGN KEY ("payin_run_id") REFERENCES "paysplit"."payin_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."sessions" ADD CONSTRAINT "sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "paysplit"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "paysplit"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_beneficiary_id_beneficiaries_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "paysplit"."beneficiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "paysplit"."rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "paysplit"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "paysplit"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transactions" ADD CONSTRAINT "transactions_salary_payment_id_salary_payments_id_fk" FOREIGN KEY ("salary_payment_id") REFERENCES "paysplit"."salary_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transfer_attempts" ADD CONSTRAINT "transfer_attempts_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "paysplit"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transfers" ADD CONSTRAINT "transfers_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "paysplit"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transfers" ADD CONSTRAINT "transfers_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "paysplit"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."transfers" ADD CONSTRAINT "transfers_beneficiary_id_beneficiaries_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "paysplit"."beneficiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "paysplit"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paysplit"."wallets" ADD CONSTRAINT "wallets_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "paysplit"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_execution" ON "paysplit"."allocations" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "allocations_payment" ON "paysplit"."allocations" USING btree ("salary_payment_id");--> statement-breakpoint
CREATE INDEX "allocations_rule" ON "paysplit"."allocations" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_once_per_destination" ON "paysplit"."allocations" USING btree ("salary_payment_id","destination_key") WHERE status in ('pending','success');--> statement-breakpoint
CREATE INDEX "audit_logs_user" ON "paysplit"."audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_time" ON "paysplit"."audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "beneficiaries_account" ON "paysplit"."beneficiaries" USING btree ("user_id","account_fingerprint") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "executions_user" ON "paysplit"."executions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "executions_auto_per_payment" ON "paysplit"."executions" USING btree ("salary_payment_id") WHERE trigger = 'automatic';--> statement-breakpoint
CREATE UNIQUE INDEX "executions_auto_per_cycle" ON "paysplit"."executions" USING btree ("user_id","pay_cycle") WHERE trigger = 'automatic';--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_once" ON "paysplit"."idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "paysplit"."jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe" ON "paysplit"."jobs" USING btree ("dedupe_key") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "kyc_cases_user" ON "paysplit"."kyc_cases" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_cases_one_open" ON "paysplit"."kyc_cases" USING btree ("user_id") WHERE status in ('in_progress','pending_review','action_required','approved');--> statement-breakpoint
CREATE INDEX "ledger_accounts_user" ON "paysplit"."ledger_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account" ON "paysplit"."ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal" ON "paysplit"."ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "paysplit"."notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_issues_open" ON "paysplit"."reconciliation_issues" USING btree ("kind","subject") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "rules_user" ON "paysplit"."rules" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_one_per_wallet" ON "paysplit"."rules" USING btree ("wallet_id") WHERE status <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "rules_one_per_beneficiary" ON "paysplit"."rules" USING btree ("beneficiary_id") WHERE status <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "salary_payments_provider_ref" ON "paysplit"."salary_payments" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "salary_payments_user" ON "paysplit"."salary_payments" USING btree ("user_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_runs_once" ON "paysplit"."scheduled_runs" USING btree ("task","window");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "paysplit"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user" ON "paysplit"."transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_wallet" ON "paysplit"."transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "transactions_beneficiary" ON "paysplit"."transactions" USING btree ("beneficiary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_attempts_no" ON "paysplit"."transfer_attempts" USING btree ("transfer_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_attempts_one_live" ON "paysplit"."transfer_attempts" USING btree ("transfer_id") WHERE status not in ('failed','reversed');--> statement-breakpoint
CREATE INDEX "transfers_open" ON "paysplit"."transfers" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_name" ON "paysplit"."wallets" USING btree ("user_id",lower("name")) WHERE status = 'active';