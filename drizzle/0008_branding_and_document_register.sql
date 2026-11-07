CREATE TABLE "brand_assets" (
	"variant" varchar(30) PRIMARY KEY NOT NULL,
	"mime_type" varchar(60) NOT NULL,
	"data_base64" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(40) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"title" varchar(200) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(64),
	"loan_account_id" uuid,
	"subject_user_id" uuid,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_documents_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_loan_account_id_loan_accounts_id_fk" FOREIGN KEY ("loan_account_id") REFERENCES "public"."loan_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issued_documents_sha_idx" ON "issued_documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "issued_documents_loan_idx" ON "issued_documents" USING btree ("loan_account_id");--> statement-breakpoint
CREATE TRIGGER issued_documents_append_only BEFORE UPDATE OR DELETE ON issued_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
