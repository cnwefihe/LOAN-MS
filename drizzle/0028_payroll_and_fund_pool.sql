-- Automatic salary deductions once the Payroll Officer confirms the first one.
ALTER TABLE "loan_accounts" ADD COLUMN "deductions_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "loan_accounts" ADD COLUMN "deductions_confirmed_by" uuid REFERENCES "users"("id");
--> statement-breakpoint
-- The money set aside for staff loans each year.
CREATE TABLE "fund_pools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "year" integer NOT NULL UNIQUE,
  "amount" numeric(18, 2) NOT NULL,
  "note" text,
  "set_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fund_pools_amount_not_negative" CHECK ("amount" >= 0)
);
--> statement-breakpoint
-- Repaying the whole balance early, confirmed by the Payroll Manager.
CREATE TABLE "early_repayments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "loan_account_id" uuid NOT NULL REFERENCES "loan_accounts"("id"),
  "requested_by" uuid NOT NULL REFERENCES "users"("id"),
  "quote_date" date NOT NULL,
  "amount" numeric(18, 2) NOT NULL,
  "principal" numeric(18, 2) NOT NULL,
  "interest" numeric(18, 2) NOT NULL,
  "interest_saved" numeric(18, 2) DEFAULT '0' NOT NULL,
  "payer_reference" varchar(100),
  "receipt_document_id" uuid NOT NULL REFERENCES "documents"("id"),
  "status" "claim_status" DEFAULT 'pending' NOT NULL,
  "reviewed_by" uuid REFERENCES "users"("id"),
  "reviewed_at" timestamp with time zone,
  "review_comment" text,
  "transaction_id" uuid REFERENCES "financial_transactions"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "early_repayments_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "early_repayments_loan_idx" ON "early_repayments" ("loan_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "early_repayments_one_pending_uq" ON "early_repayments" ("loan_account_id") WHERE "status" = 'pending';
--> statement-breakpoint
-- Confirming repayments moves from the Bursary Officer to the Payroll Officer.
DELETE FROM "role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'BURSARY_OFFICER')
  AND "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'repayment.confirm');
