ALTER TABLE "departments" ADD COLUMN "head_user_id" uuid;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "cooperative_monthly_deduction" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "cooperative_balance" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_user_id_users_id_fk" FOREIGN KEY ("head_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;