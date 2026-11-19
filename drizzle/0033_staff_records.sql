-- Staff records kept by the administrator (employee code, pay grade, employment date, confirmed or not),
-- uploaded from a spreadsheet; each staff member's profile is filled from theirs.
CREATE TABLE "staff_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "employee_code" varchar(40) NOT NULL,
  "email" varchar(320),
  "pay_grade" varchar(120) NOT NULL,
  "employment_date" date NOT NULL,
  "confirmed" boolean NOT NULL,
  "updated_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_records_code_uq" ON "staff_records" (lower("employee_code"));
--> statement-breakpoint
CREATE INDEX "staff_records_email_idx" ON "staff_records" (lower("email"));
--> statement-breakpoint
-- Each school can have its own account for early repayments.
ALTER TABLE "schools" ADD COLUMN "early_repayment_bank" varchar(100);
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "early_repayment_account_name" varchar(150);
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "early_repayment_account_number" varchar(10);
