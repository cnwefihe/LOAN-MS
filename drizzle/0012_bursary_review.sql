ALTER TYPE "public"."application_status" ADD VALUE 'pending_bursary' BEFORE 'returned';--> statement-breakpoint
CREATE TABLE "bursary_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" varchar(20) NOT NULL,
	"last_loan_date" date,
	"last_loan_repaid_date" date,
	"monthly_gross" numeric(18, 2),
	"monthly_net" numeric(18, 2),
	"monthly_deduction" numeric(18, 2),
	"take_home_after" numeric(18, 2),
	"take_home_percent" numeric(6, 2),
	"take_home_test_passed" boolean,
	"funds_available" boolean DEFAULT false NOT NULL,
	"comments" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD COLUMN "relationship" varchar(60);--> statement-breakpoint
ALTER TABLE "application_guarantors" ADD COLUMN "guarantor_phone" varchar(60);--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "residential_address" text;--> statement-breakpoint
ALTER TABLE "bursary_reviews" ADD CONSTRAINT "bursary_reviews_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bursary_reviews" ADD CONSTRAINT "bursary_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bursary_reviews_app_idx" ON "bursary_reviews" USING btree ("application_id");