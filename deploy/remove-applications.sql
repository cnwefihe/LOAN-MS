-- Removes test loan applications and everything recorded about them: the application, its guarantors,
-- Human Resources and Bursary checks, approvals, history, messages, the loan account, schedules, payments,
-- ledger entries, claims, early repayments, documents, issued documents, notifications, emails and the
-- activity log entries. Staff accounts, profiles and payslips are kept. The removed references are given
-- again to the next new applications, oldest first.
--
-- Run only through deploy/remove-applications.sh, which creates the temporary table rm_refs(ref) with the
-- references, wraps this in one transaction, and commits only when asked to (otherwise it rolls back).

create temp table rm_apps on commit drop as
  select id, reference from loan_applications where reference in (select ref from rm_refs);

do $$
declare missing text;
begin
  select string_agg(ref, ', ') into missing from rm_refs where ref not in (select reference from rm_apps);
  if missing is not null then raise exception 'No application has the reference: %', missing; end if;
end $$;

create temp table rm_loans on commit drop as select id from loan_accounts where application_id in (select id from rm_apps);
create temp table rm_guars on commit drop as select id from application_guarantors where application_id in (select id from rm_apps);
create temp table rm_txns on commit drop as select id from financial_transactions where loan_account_id in (select id from rm_loans);
create temp table rm_claims on commit drop as select id, evidence_document_id from repayment_claims where loan_account_id in (select id from rm_loans);
create temp table rm_early on commit drop as select id, receipt_document_id from early_repayments where loan_account_id in (select id from rm_loans);
create temp table rm_restr on commit drop as select id from restructure_requests where loan_account_id in (select id from rm_loans);
create temp table rm_scheds on commit drop as select id from repayment_schedules where loan_account_id in (select id from rm_loans);

-- Documents about these applications. A payslip kept on the staff member's profile stays (it is only unlinked).
create temp table rm_docs on commit drop as
  select id, storage_key from documents d
  where (d.application_id in (select id from rm_apps)
      or d.loan_account_id in (select id from rm_loans)
      or d.application_guarantor_id in (select id from rm_guars)
      or d.id in (select document_id from loan_agreements where loan_account_id in (select id from rm_loans))
      or d.id in (select evidence_document_id from disbursements where loan_account_id in (select id from rm_loans))
      or d.id in (select evidence_document_id from rm_claims)
      or d.id in (select receipt_document_id from rm_early))
    and d.id not in (select document_id from staff_payslips);

-- Every id and reference, to find notifications, emails and activity entries that mention them.
create temp table rm_keys on commit drop as
  select reference as k from rm_apps
  union select id::text from rm_apps union select id::text from rm_loans union select id::text from rm_guars
  union select id::text from rm_txns union select id::text from rm_claims union select id::text from rm_early
  union select id::text from rm_restr union select id::text from rm_scheds union select id::text from rm_docs;

create temp table rm_notes on commit drop as
  select n.id from notifications n
  where exists (select 1 from rm_keys k where strpos(concat_ws(' ', n.link, n.dedupe_key, n.title, n.body), k.k) > 0);
create temp table rm_mail on commit drop as
  select e.id from email_outbox e
  where e.notification_id in (select id from rm_notes)
     or exists (select 1 from rm_keys k where strpos(concat_ws(' ', e.dedupe_key, e.subject, e.body), k.k) > 0);
create temp table rm_audit on commit drop as
  select a.id from audit_logs a
  where a.entity_id in (select k from rm_keys)
     or exists (select 1 from rm_keys k where strpos(concat_ws(' ', a.summary, a.before::text, a.after::text), k.k) > 0);
create temp table rm_issued on commit drop as
  select i.id from issued_documents i
  where i.loan_account_id in (select id from rm_loans) or i.reference in (select reference from rm_apps) or i.entity_id in (select k from rm_keys);

-- What will be removed.
select a.reference,
  (select count(*) from loan_accounts l where l.application_id = a.id) as loan_accounts,
  (select count(*) from application_guarantors g where g.application_id = a.id) as guarantors,
  (select count(*) from financial_transactions t join loan_accounts l on l.id = t.loan_account_id where l.application_id = a.id) as payments_and_postings
from rm_apps a order by a.reference;

select 'documents' as removed, count(*) as rows from rm_docs
union all select 'issued documents', count(*) from rm_issued
union all select 'notifications', count(*) from rm_notes
union all select 'emails', count(*) from rm_mail
union all select 'activity log entries', count(*) from rm_audit
union all select 'ledger entries', count(*) from ledger_entries where loan_account_id in (select id from rm_loans)
union all select 'repayment claims', count(*) from rm_claims
union all select 'early repayments', count(*) from rm_early;

-- These tables refuse edits and deletions, to protect the record. Their protection is lifted for this
-- transaction only and switched back on below, before the transaction ends.
alter table audit_logs disable trigger user;
alter table ledger_entries disable trigger user;
alter table workflow_transitions disable trigger user;
alter table approvals disable trigger user;
alter table hr_verifications disable trigger user;
alter table guarantor_assessments disable trigger user;
alter table document_access_logs disable trigger user;
alter table issued_documents disable trigger user;
alter table financial_transactions disable trigger user;
alter table disbursements disable trigger user;
alter table repayment_claims disable trigger user;

delete from email_outbox where id in (select id from rm_mail);
delete from notifications where id in (select id from rm_notes);
delete from audit_logs where id in (select id from rm_audit);
delete from issued_documents where id in (select id from rm_issued);
delete from document_access_logs where document_id in (select id from rm_docs);

delete from ledger_entries where loan_account_id in (select id from rm_loans);
delete from disbursements where loan_account_id in (select id from rm_loans);
delete from repayment_claims where id in (select id from rm_claims);
delete from early_repayments where id in (select id from rm_early);
delete from restructure_requests where id in (select id from rm_restr);
delete from schedule_instalments where loan_account_id in (select id from rm_loans);
delete from repayment_schedules where id in (select id from rm_scheds);
delete from loan_agreements where loan_account_id in (select id from rm_loans);
delete from financial_transactions where id in (select id from rm_txns);

-- A profile payslip that was attached to the application stays, unlinked from it.
update documents set application_id = null, loan_account_id = null, application_guarantor_id = null
  where id in (select document_id from staff_payslips)
    and (application_id in (select id from rm_apps) or loan_account_id in (select id from rm_loans) or application_guarantor_id in (select id from rm_guars));
delete from documents where id in (select id from rm_docs);

delete from guarantor_assessments where application_guarantor_id in (select id from rm_guars);
delete from application_guarantors where id in (select id from rm_guars);
delete from hr_verifications where application_id in (select id from rm_apps);
delete from bursary_reviews where application_id in (select id from rm_apps);
delete from approvals where application_id in (select id from rm_apps);
delete from workflow_transitions where application_id in (select id from rm_apps);
delete from application_messages where application_id in (select id from rm_apps);
delete from loan_accounts where id in (select id from rm_loans);
delete from loan_applications where id in (select id from rm_apps);

alter table audit_logs enable trigger user;
alter table ledger_entries enable trigger user;
alter table workflow_transitions enable trigger user;
alter table approvals enable trigger user;
alter table hr_verifications enable trigger user;
alter table guarantor_assessments enable trigger user;
alter table document_access_logs enable trigger user;
alter table issued_documents enable trigger user;
alter table financial_transactions enable trigger user;
alter table disbursements enable trigger user;
alter table repayment_claims enable trigger user;

-- The next new applications are given these references again, oldest first.
insert into freed_references (reference) select reference from rm_apps on conflict do nothing;

-- One line in the activity log says the test applications were removed.
insert into audit_logs (action, entity_type, summary)
  select 'maintenance.test_applications_removed', 'loan_application', 'Test applications removed: ' || string_agg(reference, ', ' order by reference) from rm_apps;

-- The encrypted files to delete from document storage (read by the script).
select 'FILE ' || storage_key as file from rm_docs;
