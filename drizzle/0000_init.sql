CREATE TYPE "public"."agreement_type" AS ENUM('loan', 'guarantor');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('draft', 'pending_guarantor', 'pending_hr', 'returned', 'pending_approval', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'declined', 'returned', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."assessment_outcome" AS ENUM('capable', 'not_capable', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."disbursement_status" AS ENUM('pending_confirmation', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'failed', 'not_configured');--> statement-breakpoint
CREATE TYPE "public"."employment_status" AS ENUM('probation', 'confirmed', 'contract', 'suspended', 'on_leave', 'exited');--> statement-breakpoint
CREATE TYPE "public"."entry_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."guarantor_status" AS ENUM('pending', 'accepted', 'declined', 'clarification_requested', 'withdrawn', 'replaced');--> statement-breakpoint
CREATE TYPE "public"."hr_outcome" AS ENUM('verified', 'declined', 'returned');--> statement-breakpoint
CREATE TYPE "public"."instalment_status" AS ENUM('pending', 'partial', 'paid', 'overdue', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('loan_principal', 'interest_receivable', 'unearned_interest', 'cash_bank', 'fee_income', 'overpayment_liability', 'adjustments');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('pending_disbursement', 'active', 'overdue', 'defaulted', 'closed', 'written_off', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank_transfer', 'cheque', 'internal_transfer', 'payroll');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('draft', 'pending_approval', 'active', 'retired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."restructure_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."salary_source" AS ENUM('unverified', 'self_declared', 'hr_verified', 'payroll');--> statement-breakpoint
CREATE TYPE "public"."txn_status" AS ENUM('pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."txn_type" AS ENUM('disbursement', 'repayment', 'early_settlement', 'adjustment', 'reversal', 'interest_recognition', 'interest_rebate', 'fee', 'refund');--> statement-breakpoint
CREATE TABLE "application_guarantors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"guarantor_id" uuid NOT NULL,
	"status" "guarantor_status" DEFAULT 'pending' NOT NULL,
	"guaranteed_amount" numeric(18, 2) NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"response_comment" text,
	"agreement_terms_id" uuid,
	"agreement_version" integer,
	"acknowledgement_hash" varchar(64),
	"acknowledged_name" varchar(200),
	"acknowledged_email" varchar(320),
	"acknowledged_ip" varchar(64),
	"acknowledged_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"approver_id" uuid NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"approved_amount" numeric(18, 2),
	"approved_tenor_months" integer,
	"comments" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" varchar(80) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(64),
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid,
	"code" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "disbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"status" "disbursement_status" DEFAULT 'pending_confirmation' NOT NULL,
	"approved_amount" numeric(18, 2) NOT NULL,
	"fees_deducted" numeric(18, 2) DEFAULT '0' NOT NULL,
	"amount_disbursed" numeric(18, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"transaction_reference" varchar(100) NOT NULL,
	"beneficiary_name" varchar(200) NOT NULL,
	"beneficiary_bank" varchar(120),
	"beneficiary_account_last4" varchar(4),
	"evidence_document_id" uuid,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"rejection_reason" text,
	"transaction_id" uuid,
	"idempotency_key" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disbursements_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "document_access_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"code" varchar(50) NOT NULL,
	"label" varchar(200) NOT NULL,
	"applies_to" varchar(20) DEFAULT 'applicant' NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" varchar(50) NOT NULL,
	"title" varchar(200) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_key" varchar(300) NOT NULL,
	"owner_user_id" uuid,
	"application_id" uuid,
	"loan_account_id" uuid,
	"application_guarantor_id" uuid,
	"requirement_code" varchar(50),
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"is_system_generated" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid,
	"to_address" varchar(320) NOT NULL,
	"subject" varchar(250) NOT NULL,
	"body" text NOT NULL,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dedupe_key" varchar(120),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "financial_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(40) NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"type" "txn_type" NOT NULL,
	"status" "txn_status" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"value_date" date NOT NULL,
	"narration" text NOT NULL,
	"external_reference" varchar(100),
	"idempotency_key" varchar(80) NOT NULL,
	"reverses_transaction_id" uuid,
	"proposed_entries" jsonb,
	"maker_id" uuid NOT NULL,
	"checker_id" uuid,
	"checked_at" timestamp with time zone,
	"rejection_reason" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_transactions_reference_unique" UNIQUE("reference"),
	CONSTRAINT "financial_transactions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "txn_amount_positive" CHECK ("financial_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "guarantor_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_guarantor_id" uuid NOT NULL,
	"assessed_by" uuid NOT NULL,
	"outcome" "assessment_outcome" NOT NULL,
	"existing_exposure" numeric(18, 2) NOT NULL,
	"monthly_net_at_assessment" numeric(18, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"officer_id" uuid NOT NULL,
	"outcome" "hr_outcome" NOT NULL,
	"employment_verified" boolean NOT NULL,
	"salary_verified" boolean NOT NULL,
	"staff_status_verified" boolean NOT NULL,
	"department_verified" boolean NOT NULL,
	"service_months" integer,
	"verified_monthly_basic" numeric(18, 2),
	"verified_monthly_gross" numeric(18, 2),
	"verified_monthly_net" numeric(18, 2),
	"existing_obligations" numeric(18, 2),
	"recomputed_eligible_amount" numeric(18, 2),
	"due_diligence_notes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"direction" "entry_direction" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_positive" CHECK ("ledger_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_number" varchar(30) NOT NULL,
	"application_id" uuid NOT NULL,
	"borrower_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"status" "loan_status" DEFAULT 'pending_disbursement' NOT NULL,
	"principal" numeric(18, 2) NOT NULL,
	"interest_method" varchar(20) NOT NULL,
	"annual_interest_rate" numeric(9, 4) NOT NULL,
	"tenor_months" integer NOT NULL,
	"total_interest" numeric(18, 2) NOT NULL,
	"total_fees" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_repayable" numeric(18, 2) NOT NULL,
	"monthly_instalment" numeric(18, 2) NOT NULL,
	"principal_outstanding" numeric(18, 2) DEFAULT '0' NOT NULL,
	"interest_outstanding" numeric(18, 2) DEFAULT '0' NOT NULL,
	"overpayment_balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_repaid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"days_past_due" integer DEFAULT 0 NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone NOT NULL,
	"disbursed_at" timestamp with time zone,
	"first_due_date" date,
	"maturity_date" date,
	"closed_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_accounts_account_number_unique" UNIQUE("account_number"),
	CONSTRAINT "loan_accounts_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "loan_principal_positive" CHECK ("loan_accounts"."principal" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"type" "agreement_type" NOT NULL,
	"party_user_id" uuid NOT NULL,
	"terms_document_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"document_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(30) NOT NULL,
	"applicant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"requested_amount" numeric(18, 2) NOT NULL,
	"tenor_months" integer NOT NULL,
	"purpose" text NOT NULL,
	"salary_snapshot" jsonb NOT NULL,
	"quote" jsonb NOT NULL,
	"eligible_amount" numeric(18, 2),
	"current_approval_level" integer DEFAULT 0 NOT NULL,
	"is_escalated" boolean DEFAULT false NOT NULL,
	"terms_document_id" uuid,
	"terms_accepted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_applications_reference_unique" UNIQUE("reference"),
	CONSTRAINT "applications_amount_positive" CHECK ("loan_applications"."requested_amount" > 0),
	CONSTRAINT "applications_tenor_positive" CHECK ("loan_applications"."tenor_months" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_products_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(150) NOT NULL,
	"subject" varchar(250) NOT NULL,
	"body" text NOT NULL,
	"send_email" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_code" varchar(60) NOT NULL,
	"title" varchar(250) NOT NULL,
	"body" text NOT NULL,
	"link" varchar(300),
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(80) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(50) NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "policy_status" DEFAULT 'draft' NOT NULL,
	"parameters" jsonb NOT NULL,
	"change_note" text,
	"effective_from" timestamp with time zone,
	"created_by" uuid,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" varchar(200) PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_counters" (
	"prefix" varchar(20) PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repayment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"claimed_by" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"deduction_month" date NOT NULL,
	"channel" "payment_method" DEFAULT 'payroll' NOT NULL,
	"payer_reference" varchar(100),
	"evidence_document_id" uuid,
	"note" text,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_amount_positive" CHECK ("repayment_claims"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "repayment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"reason" varchar(50) NOT NULL,
	"base_principal" numeric(18, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restructure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"proposed_tenor_months" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "restructure_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"new_schedule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "schedule_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"loan_account_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_date" date NOT NULL,
	"principal_due" numeric(18, 2) NOT NULL,
	"interest_due" numeric(18, 2) NOT NULL,
	"total_due" numeric(18, 2) NOT NULL,
	"principal_paid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"interest_paid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"opening_balance" numeric(18, 2) NOT NULL,
	"closing_balance" numeric(18, 2) NOT NULL,
	"status" "instalment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"auth_method" varchar(20) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "staff_categories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"staff_number" varchar(40),
	"school_id" uuid,
	"department_id" uuid,
	"category_id" uuid,
	"designation" varchar(150),
	"entra_job_title" varchar(150),
	"entra_department" varchar(150),
	"phone" varchar(30),
	"employment_status" "employment_status",
	"employment_date" date,
	"confirmation_date" date,
	"monthly_basic" numeric(18, 2),
	"monthly_gross" numeric(18, 2),
	"monthly_net" numeric(18, 2),
	"salary_source" "salary_source" DEFAULT 'unverified' NOT NULL,
	"salary_verified_by" uuid,
	"salary_verified_at" timestamp with time zone,
	"employment_verified_by" uuid,
	"employment_verified_at" timestamp with time zone,
	"bank_name" varchar(120),
	"bank_account_number_enc" text,
	"bank_account_last4" varchar(4),
	"bank_account_name" varchar(200),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_profiles_staff_number_unique" UNIQUE("staff_number")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entra_oid" varchar(64),
	"entra_tenant_id" varchar(64),
	"email" varchar(320) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"given_name" varchar(100),
	"surname" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"is_dev_fixture" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid")
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"action" varchar(50) NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status" NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_role" varchar(50) NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD CONSTRAINT "application_guarantors_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD CONSTRAINT "application_guarantors_guarantor_id_users_id_fk" FOREIGN KEY ("guarantor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD CONSTRAINT "application_guarantors_agreement_terms_id_terms_documents_id_fk" FOREIGN KEY ("agreement_terms_id") REFERENCES "public"."terms_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_evidence_document_id_documents_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_logs" ADD CONSTRAINT "document_access_logs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_logs" ADD CONSTRAINT "document_access_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_application_guarantor_id_application_guarantors_id_fk" FOREIGN KEY ("application_guarantor_id") REFERENCES "public"."application_guarantors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_maker_id_users_id_fk" FOREIGN KEY ("maker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_checker_id_users_id_fk" FOREIGN KEY ("checker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_assessments" ADD CONSTRAINT "guarantor_assessments_application_guarantor_id_application_guarantors_id_fk" FOREIGN KEY ("application_guarantor_id") REFERENCES "public"."application_guarantors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_assessments" ADD CONSTRAINT "guarantor_assessments_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_verifications" ADD CONSTRAINT "hr_verifications_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_verifications" ADD CONSTRAINT "hr_verifications_officer_id_users_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD CONSTRAINT "loan_accounts_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD CONSTRAINT "loan_accounts_borrower_id_users_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD CONSTRAINT "loan_accounts_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD CONSTRAINT "loan_accounts_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD CONSTRAINT "loan_accounts_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_agreements" ADD CONSTRAINT "loan_agreements_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_agreements" ADD CONSTRAINT "loan_agreements_party_user_id_users_id_fk" FOREIGN KEY ("party_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_agreements" ADD CONSTRAINT "loan_agreements_terms_document_id_terms_documents_id_fk" FOREIGN KEY ("terms_document_id") REFERENCES "public"."terms_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_agreements" ADD CONSTRAINT "loan_agreements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_terms_document_id_terms_documents_id_fk" FOREIGN KEY ("terms_document_id") REFERENCES "public"."terms_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_products" ADD CONSTRAINT "loan_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_claims" ADD CONSTRAINT "repayment_claims_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_claims" ADD CONSTRAINT "repayment_claims_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_claims" ADD CONSTRAINT "repayment_claims_evidence_document_id_documents_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_claims" ADD CONSTRAINT "repayment_claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_claims" ADD CONSTRAINT "repayment_claims_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_schedules" ADD CONSTRAINT "repayment_schedules_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_schedules" ADD CONSTRAINT "repayment_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restructure_requests" ADD CONSTRAINT "restructure_requests_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restructure_requests" ADD CONSTRAINT "restructure_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restructure_requests" ADD CONSTRAINT "restructure_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restructure_requests" ADD CONSTRAINT "restructure_requests_new_schedule_id_repayment_schedules_id_fk" FOREIGN KEY ("new_schedule_id") REFERENCES "public"."repayment_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_instalments" ADD CONSTRAINT "schedule_instalments_schedule_id_repayment_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."repayment_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_instalments" ADD CONSTRAINT "schedule_instalments_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_category_id_staff_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."staff_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_salary_verified_by_users_id_fk" FOREIGN KEY ("salary_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_employment_verified_by_users_id_fk" FOREIGN KEY ("employment_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_documents" ADD CONSTRAINT "terms_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_guarantors_guarantor_idx" ON "application_guarantors" USING btree ("guarantor_id");--> statement-breakpoint
CREATE INDEX "app_guarantors_app_idx" ON "application_guarantors" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_guarantors_live_uq" ON "application_guarantors" USING btree ("application_id","guarantor_id") WHERE "application_guarantors"."status" not in ('withdrawn','replaced','declined');--> statement-breakpoint
CREATE INDEX "app_messages_app_idx" ON "application_messages" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "approvals_app_idx" ON "approvals" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "disbursements_reference_uq" ON "disbursements" USING btree ("transaction_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "disbursements_one_live_uq" ON "disbursements" USING btree ("loan_account_id") WHERE "disbursements"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "doc_req_product_code_uq" ON "document_requirements" USING btree ("product_id","code");--> statement-breakpoint
CREATE INDEX "documents_app_idx" ON "documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "documents_loan_idx" ON "documents" USING btree ("loan_account_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "email_outbox_status_idx" ON "email_outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "txn_loan_idx" ON "financial_transactions" USING btree ("loan_account_id","value_date");--> statement-breakpoint
CREATE UNIQUE INDEX "txn_external_ref_uq" ON "financial_transactions" USING btree ("type","external_reference") WHERE "financial_transactions"."external_reference" is not null and "financial_transactions"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "txn_single_reversal_uq" ON "financial_transactions" USING btree ("reverses_transaction_id") WHERE "financial_transactions"."reverses_transaction_id" is not null and "financial_transactions"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "hr_verifications_app_idx" ON "hr_verifications" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ledger_loan_account_idx" ON "ledger_entries" USING btree ("loan_account_id","account");--> statement-breakpoint
CREATE INDEX "ledger_txn_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "loan_accounts_borrower_idx" ON "loan_accounts" USING btree ("borrower_id");--> statement-breakpoint
CREATE INDEX "loan_accounts_status_idx" ON "loan_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_applicant_idx" ON "loan_applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "loan_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_product_version_uq" ON "policy_versions" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_one_active_uq" ON "policy_versions" USING btree ("product_id") WHERE "policy_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "claims_loan_idx" ON "repayment_claims" USING btree ("loan_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_pending_per_month_uq" ON "repayment_claims" USING btree ("loan_account_id","deduction_month") WHERE "repayment_claims"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_loan_version_uq" ON "repayment_schedules" USING btree ("loan_account_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_one_current_uq" ON "repayment_schedules" USING btree ("loan_account_id") WHERE "repayment_schedules"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "restructure_one_pending_uq" ON "restructure_requests" USING btree ("loan_account_id") WHERE "restructure_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "instalments_schedule_seq_uq" ON "schedule_instalments" USING btree ("schedule_id","sequence");--> statement-breakpoint
CREATE INDEX "instalments_loan_due_idx" ON "schedule_instalments" USING btree ("loan_account_id","due_date");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_profiles_dept_idx" ON "staff_profiles" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_kind_version_uq" ON "terms_documents" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_one_active_uq" ON "terms_documents" USING btree ("kind") WHERE "terms_documents"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "wf_transitions_app_idx" ON "workflow_transitions" USING btree ("application_id","created_at");