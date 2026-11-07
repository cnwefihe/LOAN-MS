ALTER TABLE "staff_profiles" ADD COLUMN "payslip_name" varchar(200);--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "payslip_details_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "payslip_details_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "payslip_details_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_payslip_details_confirmed_by_users_id_fk" FOREIGN KEY ("payslip_details_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "staff_profiles" SET "payslip_details_confirmed_at" = now() WHERE "staff_number" IS NOT NULL AND "pay_grade" IS NOT NULL;