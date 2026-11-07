/**
 * npm run docs:samples
 *
 * Produces sample PDFs (receipt, statement, advice, clearance letter and the standard reports) from a
 * throwaway in-memory database with development fixtures, so the layout, logo and security markings
 * can be reviewed without touching any real environment. Output: .data/sample-documents/
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-samples-"));

async function main() {
  const { getDb } = await import("../src/db");
  const { seedBase, seedFixtures } = await import("../src/server/seed");
  const { loadActor } = await import("../src/server/services/identity");
  const { saveDraft, submitApplication } = await import("../src/server/services/applications");
  const { respondToGuarantee } = await import("../src/server/services/guarantors");
  const { recordHrDecision } = await import("../src/server/services/hr");
  const { decideApplication } = await import("../src/server/services/approvals");
  const { reviewByBursary } = await import("../src/server/services/bursary");
  const { storeDocument } = await import("../src/server/services/documents");
  const loans = await import("../src/server/services/loans");
  const { settlementQuote } = await import("../src/server/services/ledger");
  const { buildDataset, reportParams } = await import("../src/server/services/reports");
  const { managementPdf, datasetPdf } = await import("../src/server/report-render");
  const { todayLagos, addMonths } = await import("../src/lib/finance/dates");
  const schema = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const db = await getDb();
  let ids: Record<string, string> = {};
  let productId = "";
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    ids = r.ids;
    productId = r.productId;
  });
  const A = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "samples" }))!;
  const out = path.join(process.cwd(), ".data", "sample-documents");
  fs.mkdirSync(out, { recursive: true });

  const applicant = await A("applicant");
  const draft = await saveDraft(db, applicant, { productId, requestedAmount: "1200000", tenorMonths: 12, purpose: "Sample document generation", guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"] });
  await storeDocument(db, applicant, { buffer: Buffer.from("%PDF-1.4"), fileName: "payslip.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: applicant.userId, applicationId: draft.id, requirementCode: "PAYSLIP" });
  await submitApplication(db, applicant, draft.id, { termsAccepted: true });
  for (const g of await db.select().from(schema.applicationGuarantors).where(eq(schema.applicationGuarantors.applicationId, draft.id))) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, g.guarantorId));
    await respondToGuarantee(db, (await loadActor(db, g.guarantorId, { ip: "127.0.0.1", userAgent: "samples" }))!, g.id, { decision: "accept", typedName: u.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
  }
  const gs = await db.select().from(schema.applicationGuarantors).where(eq(schema.applicationGuarantors.applicationId, draft.id));
  await recordHrDecision(db, await A("hradmin"), draft.id, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", notes: "Sample verification.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })) });
  await reviewByBursary(db, await A("bursary"), draft.id, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
  await decideApplication(db, await A("hod"), draft.id, { decision: "approved", comments: "Sample approval by the Head of Department." });
  await decideApplication(db, await A("hrdirector"), draft.id, { decision: "approved", comments: "Sample approval by the HR Director." });
  const approved = await decideApplication(db, await A("accadmin"), draft.id, { decision: "approved", comments: "Sample approval." });
  const loanId = approved.loan!.id;
  await loans.recordDisbursement(db, await A("accounts"), loanId, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "FT-SAMPLE-1", amountDisbursed: "1200000", idempotencyKey: "sample-1" });
  const pay = await loans.recordRepayment(db, await A("bursary"), loanId, { amount: approved.loan!.monthlyInstalment, valueDate: todayLagos(), reference: "PAYROLL-SAMPLE-1", channel: "payroll", idempotencyKey: "sample-pay-1" });

  const write = (name: string, bytes: Buffer) => { fs.writeFileSync(path.join(out, name), bytes); console.log(path.join(out, name)); };
  write("receipt.pdf", (await loans.receiptPdf(db, applicant, pay.id)).bytes);
  write("statement.pdf", (await loans.statementPdf(db, applicant, loanId)).bytes);
  const forms = await import("../src/server/services/forms");
  write("application-form.pdf", (await forms.applicationFormPdf(db, applicant, draft.id)).bytes);
  write("guarantor-form.pdf", (await forms.guarantorFormPdf(db, applicant, draft.id)).bytes);
  const advice = (await db.select().from(schema.documents).where(eq(schema.documents.loanAccountId, loanId))).find((x) => x.title === "Disbursement advice")!;
  const { readDocument } = await import("../src/server/services/documents");
  write("disbursement-advice.pdf", (await readDocument(db, applicant, advice.id)).data);

  const admin = await A("admin");
  write("portfolio-report.pdf", await managementPdf(db, admin));
  write("loan-book.pdf", await datasetPdf(db, admin, "loan_book", await buildDataset(db, admin, "loan_book")));
  const month = reportParams({ month: addMonths(todayLagos(), 2).slice(0, 7) });
  write("payroll-deduction-schedule.pdf", await datasetPdf(db, admin, "payroll_deductions", await buildDataset(db, admin, "payroll_deductions", month)));

  const q = await settlementQuote(db, loanId);
  const t = await loans.proposeEarlySettlement(db, await A("accounts"), loanId, { amountReceived: q.settlementAmount, valueDate: todayLagos(), reference: "SETTLE-SAMPLE" });
  await loans.approvePendingTransaction(db, await A("accadmin"), t.id);
  write("clearance-letter.pdf", (await loans.clearancePdf(db, applicant, loanId)).bytes);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
