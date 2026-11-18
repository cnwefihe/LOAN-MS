-- Each school has its own fund pool for the year; an application draws on the pool of its department's school.
ALTER TABLE "fund_pools" DROP CONSTRAINT IF EXISTS "fund_pools_year_key";
--> statement-breakpoint
ALTER TABLE "fund_pools" DROP CONSTRAINT IF EXISTS "fund_pools_year_unique";
--> statement-breakpoint
ALTER TABLE "fund_pools" ADD COLUMN "school_id" uuid REFERENCES "schools"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fund_pools_year_school_uq" ON "fund_pools" ("year", "school_id");
--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "school_id" uuid REFERENCES "schools"("id");
--> statement-breakpoint
-- Existing applications take the school of the applicant's department.
UPDATE "loan_applications" AS a SET "school_id" = d."school_id"
FROM "staff_profiles" AS p JOIN "departments" AS d ON d."id" = p."department_id"
WHERE p."user_id" = a."applicant_id";
--> statement-breakpoint
CREATE INDEX "loan_applications_school_idx" ON "loan_applications" ("school_id");
--> statement-breakpoint
-- The Payroll Manager may set fund pools, as the Head of Account does.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."code" = 'PAYROLL_MANAGER' AND p."code" = 'fund.manage'
ON CONFLICT DO NOTHING;
