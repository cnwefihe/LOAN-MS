ALTER TABLE "financial_transactions" DROP CONSTRAINT "financial_transactions_reference_unique";--> statement-breakpoint
ALTER TABLE "issued_documents" DROP CONSTRAINT "issued_documents_reference_unique";--> statement-breakpoint
CREATE INDEX "txn_reference_idx" ON "financial_transactions" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "issued_documents_reference_idx" ON "issued_documents" USING btree ("reference");