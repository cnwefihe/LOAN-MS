ALTER TABLE "application_guarantors" ADD COLUMN "declared_basic" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "advance_base_amount" numeric(18, 2);