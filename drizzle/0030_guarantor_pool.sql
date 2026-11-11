-- Guarantors are chosen from a list of the managerial cadre kept by an administrator.
CREATE TABLE IF NOT EXISTS "guarantor_pool" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(150) NOT NULL,
  "email" varchar(255) NOT NULL,
  "cadre" varchar(60) DEFAULT 'Managerial' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guarantor_pool_email_uq" ON "guarantor_pool" (lower("email"));
--> statement-breakpoint
-- Loan policy: guarantors need 12 months of service, may stand for up to two active loans, and are checked at 30% of net pay.
UPDATE "policy_versions"
SET "parameters" = "parameters" || '{"guarantorMinServiceMonths": 12, "maxGuaranteesPerGuarantor": 2, "guarantorMaxDeductionPercent": 30}'::jsonb
WHERE "status" IN ('active', 'draft');
--> statement-breakpoint
-- The Bereavement Loan carries no interest and needs no guarantors.
UPDATE "policy_versions"
SET "parameters" = "parameters" || '{"requiredGuarantors": 0, "interestMethod": "interest_free", "annualInterestRate": 0}'::jsonb
WHERE "status" IN ('active', 'draft')
  AND "product_id" IN (SELECT "id" FROM "loan_products" WHERE "code" = 'BEREAVEMENT');
--> statement-breakpoint
INSERT INTO "system_settings" ("key", "value", "is_sensitive")
VALUES ('lending.oneGuaranteeAtATime', 'false'::jsonb, true)
ON CONFLICT ("key") DO UPDATE SET "value" = 'false'::jsonb;
