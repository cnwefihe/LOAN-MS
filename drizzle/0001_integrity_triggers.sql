-- Financial and audit integrity controls enforced by the database itself,
-- so they hold even if application code is wrong or someone connects directly.

-- 1. Append-only tables: no UPDATE or DELETE ever.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not permitted. Use a reversal or adjustment record.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_transitions_append_only BEFORE UPDATE OR DELETE ON workflow_transitions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER hr_verifications_append_only BEFORE UPDATE OR DELETE ON hr_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER guarantor_assessments_append_only BEFORE UPDATE OR DELETE ON guarantor_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER document_access_logs_append_only BEFORE UPDATE OR DELETE ON document_access_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- 2. Financial transactions: never deleted; once posted or rejected they are frozen.
--    While pending approval only the checker fields / status may change.
CREATE OR REPLACE FUNCTION guard_financial_transaction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Financial transactions cannot be deleted (reference %). Post a reversal instead.', OLD.reference
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Financial transaction % is % and can no longer be modified.', OLD.reference, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.loan_account_id <> OLD.loan_account_id OR NEW.type <> OLD.type
     OR NEW.value_date <> OLD.value_date OR NEW.maker_id <> OLD.maker_id OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'Only approval fields of pending transaction % may change.', OLD.reference
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.checker_id IS NOT NULL AND NEW.checker_id = NEW.maker_id THEN
    RAISE EXCEPTION 'Maker-checker violation: the maker cannot approve transaction %.', OLD.reference
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER financial_transactions_guard BEFORE UPDATE OR DELETE ON financial_transactions FOR EACH ROW EXECUTE FUNCTION guard_financial_transaction();
--> statement-breakpoint

-- 3. Confirmed disbursements and decided repayment claims are frozen; neither can be deleted.
CREATE OR REPLACE FUNCTION guard_decided_record() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted.', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status::text NOT IN ('pending', 'pending_confirmation') THEN
    RAISE EXCEPTION '% record % is already % and cannot be modified.', TG_TABLE_NAME, OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER disbursements_guard BEFORE UPDATE OR DELETE ON disbursements FOR EACH ROW EXECUTE FUNCTION guard_decided_record();
--> statement-breakpoint
CREATE TRIGGER repayment_claims_guard BEFORE UPDATE OR DELETE ON repayment_claims FOR EACH ROW EXECUTE FUNCTION guard_decided_record();
--> statement-breakpoint

-- 4. Double-entry: every transaction's ledger lines must balance (checked at COMMIT).
CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  diff numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
    INTO diff FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Unbalanced ledger for transaction %: debits minus credits = %', NEW.transaction_id, diff
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
--> statement-breakpoint

-- 5. Ledger lines may only be attached to posted transactions.
CREATE OR REPLACE FUNCTION assert_ledger_txn_posted() RETURNS trigger AS $$
DECLARE
  s txn_status;
BEGIN
  SELECT status INTO s FROM financial_transactions WHERE id = NEW.transaction_id;
  IF s IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'Ledger entries require a posted transaction (transaction % is %).', NEW.transaction_id, s
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_require_posted BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION assert_ledger_txn_posted();
