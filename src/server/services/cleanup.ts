/**
 * Removing an application entered for testing, and everything recorded about it. Only for an
 * application that never became a loan. The staff member's payslip is kept (it belongs to them, not
 * to the application). Audit, approval and access records are append-only, so this is the one place
 * allowed to remove them. Stored files with no document left are removed by the orphan sweep.
 * Run from the server with scripts/delete-application.ts.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { DomainError } from "../errors";

class DryRun extends Error {}
const rows = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as Record<string, unknown>[];

/** What was (or, without `confirm`, would be) removed, step by step. */
export async function removeTestApplication(db: Executor, reference: string, opts: { confirm: boolean }) {
  const counts: [string, number][] = [];
  try {
    await db.transaction(async (tx) => {
      // Audit, approval and access records are append-only; this one transaction is allowed past that.
      // (Replica mode also skips foreign-key checks, so the steps below remove rows in dependency order.)
      await tx.execute(sql`set local session_replication_role = replica`);
      const [app] = rows(await tx.execute(sql`select id, status from loan_applications where reference = ${reference}`));
      if (!app) throw new DomainError(`No application ${reference}.`);
      const id = app.id as string;
      if (rows(await tx.execute(sql`select 1 from loan_accounts where application_id = ${id}`)).length)
        throw new DomainError(`${reference} became a loan, so it cannot be removed.`);

      const guarantees = rows(await tx.execute(sql`select id from application_guarantors where application_id = ${id}`)).map((r) => r.id as string);
      const docs = rows(await tx.execute(sql`select d.id from documents d where (d.application_id = ${id} or d.application_guarantor_id in (select id from application_guarantors where application_id = ${id}))
        and not exists (select 1 from staff_payslips p where p.document_id = d.id)`)).map((r) => r.id as string);
      const ids = [id, ...guarantees, ...docs];
      const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
      const links = sql.join([sql`${"%" + id}`, ...guarantees.map((g) => sql`${"%" + g}`)], sql` or link like `);
      const notes = rows(await tx.execute(sql`select id from notifications where link like ${links}`)).map((r) => r.id as string);
      const noteList = notes.length ? sql.join(notes.map((x) => sql`${x}`), sql`, `) : sql`null`;
      const like = `%${reference}%`;

      const steps: [string, ReturnType<typeof sql>][] = [
        ["guarantor assessments", sql`delete from guarantor_assessments where application_guarantor_id in (select id from application_guarantors where application_id = ${id})`],
        ["document access records", sql`delete from document_access_logs where document_id in (${docs.length ? sql.join(docs.map((x) => sql`${x}`), sql`, `) : sql`null`})`],
        ["documents", sql`delete from documents where id in (${docs.length ? sql.join(docs.map((x) => sql`${x}`), sql`, `) : sql`null`})`],
        ["payslips unlinked", sql`update documents set application_id = null, application_guarantor_id = null where application_id = ${id} or application_guarantor_id in (select id from application_guarantors where application_id = ${id})`],
        ["HR verifications", sql`delete from hr_verifications where application_id = ${id}`],
        ["Bursary reviews", sql`delete from bursary_reviews where application_id = ${id}`],
        ["approvals", sql`delete from approvals where application_id = ${id}`],
        ["workflow steps", sql`delete from workflow_transitions where application_id = ${id}`],
        ["messages", sql`delete from application_messages where application_id = ${id}`],
        ["guarantor requests", sql`delete from application_guarantors where application_id = ${id}`],
        ["emails", sql`delete from email_outbox where notification_id in (${noteList}) or subject like ${like} or body like ${like}`],
        ["notifications", sql`delete from notifications where id in (${noteList}) or title like ${like} or body like ${like}`],
        ["issued documents", sql`delete from issued_documents where entity_id in (${idList}) or reference = ${reference}`],
        ["audit entries", sql`delete from audit_logs where entity_id in (${idList}) or summary like ${like}`],
        ["application", sql`delete from loan_applications where id = ${id}`],
      ];
      for (const [label, q] of steps) {
        const r = await tx.execute(q) as { affectedRows?: number; rowCount?: number };
        counts.push([label, r.affectedRows ?? r.rowCount ?? 0]);
      }
      if (!opts.confirm) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return counts;
}

/**
 * Clears every application, loan and payment entered while testing, before the system goes into use:
 * applications with their guarantees, checks, approvals, history and messages; loans with their
 * agreements, payouts, schedules, transactions and repayments; the documents and uploaded payslips;
 * notifications, sent emails and access records; the fund pool; and the running reference number, so
 * the first real application is LMS-YYMMDD-001. Audit entries about what is removed go with it.
 * Users, roles, departments, products, terms, settings, branding and the guarantor list are kept.
 * Without `confirm` nothing is changed; the counts show what would go. Stored files with no document left
 * are removed by the next automatic check. Run from the server with scripts/clear-test-data.ts.
 */
export async function clearAllTestData(db: Executor, opts: { confirm: boolean }) {
  const counts: [string, number][] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      const steps: [string, ReturnType<typeof sql>][] = [
        ["guarantor assessments", sql`delete from guarantor_assessments`],
        ["HR verifications", sql`delete from hr_verifications`],
        ["Bursary reviews", sql`delete from bursary_reviews`],
        ["approvals", sql`delete from approvals`],
        ["workflow steps", sql`delete from workflow_transitions`],
        ["messages", sql`delete from application_messages`],
        ["loan agreements", sql`delete from loan_agreements`],
        ["repayment instalments", sql`delete from schedule_instalments`],
        ["repayment schedules", sql`delete from repayment_schedules`],
        ["ledger entries", sql`delete from ledger_entries`],
        ["repayment claims", sql`delete from repayment_claims`],
        ["early repayments", sql`delete from early_repayments`],
        ["restructure requests", sql`delete from restructure_requests`],
        ["financial transactions", sql`delete from financial_transactions`],
        ["payouts", sql`delete from disbursements`],
        ["loans", sql`delete from loan_accounts`],
        ["guarantor requests", sql`delete from application_guarantors`],
        ["applications", sql`delete from loan_applications`],
        ["uploaded payslips", sql`delete from staff_payslips`],
        ["document access records", sql`delete from document_access_logs`],
        ["documents", sql`delete from documents`],
        ["issued documents", sql`delete from issued_documents`],
        ["emails", sql`delete from email_outbox`],
        ["notifications", sql`delete from notifications`],
        ["fund pools", sql`delete from fund_pools`],
        ["reference numbers", sql`delete from reference_counters where prefix = 'LMS' or prefix like 'LMS-%'`],
        ["audit entries", sql`delete from audit_logs where entity_type in ('loan_application', 'application_guarantor', 'loan_account', 'disbursement', 'financial_transaction', 'repayment_claim', 'early_repayment', 'restructure_request', 'document', 'staff_payslip', 'fund_pool', 'guarantor_assessment', 'issued_document', 'email_outbox')`],
      ];
      for (const [label, q] of steps) {
        const r = await tx.execute(q) as { affectedRows?: number; rowCount?: number };
        counts.push([label, r.affectedRows ?? r.rowCount ?? 0]);
      }
      if (!opts.confirm) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return counts;
}
