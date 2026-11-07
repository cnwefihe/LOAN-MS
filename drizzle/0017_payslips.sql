CREATE TABLE "staff_payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"period" varchar(7),
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD COLUMN "payslip_id" uuid;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD COLUMN "payslip_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "pay_grade" varchar(120);--> statement-breakpoint
ALTER TABLE "staff_payslips" ADD CONSTRAINT "staff_payslips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_payslips" ADD CONSTRAINT "staff_payslips_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_payslips_user_idx" ON "staff_payslips" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD CONSTRAINT "application_guarantors_payslip_id_staff_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."staff_payslips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_payslip_id_staff_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."staff_payslips"("id") ON DELETE no action ON UPDATE no action;