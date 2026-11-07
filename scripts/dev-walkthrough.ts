/**
 * DEVELOPMENT ONLY: drives one fixture loan through the full lifecycle using the real domain
 * services, so every screen has data to show. All data is fictional fixture data.
 *   npm run db:reset && npx tsx scripts/dev-walkthrough.ts
 */
import "./env";

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
  console.error("Development walkthrough only runs against the embedded development database.");
  process.exit(1);
}

async function main() {
  const { getDb } = await import("../src/db");
  const { eq, and } = await import("drizzle-orm");
  const s = await import("../src/db/schema");
  const { loadActor } = await import("../src/server/services/identity");
  const apps = await import("../src/server/services/applications");
  const { respondToGuarantee } = await import("../src/server/services/guarantors");
  const { recordHrDecision } = await import("../src/server/services/hr");
  const { decideApplication } = await import("../src/server/services/approvals");
  const { reviewByBursary } = await import("../src/server/services/bursary");
  const { storeDocument } = await import("../src/server/services/documents");
  const loans = await import("../src/server/services/loans");
  const { todayLagos } = await import("../src/lib/finance/dates");
  const db = await getDb();
  const by = async (email: string) => {
    const [u] = await db.select().from(s.users).where(eq(s.users.email, email));
    return (await loadActor(db, u.id, { ip: "127.0.0.1", userAgent: "dev-walkthrough" }))!;
  };
  // The Personal Loan when it is open (development), otherwise the internal test product (browser tests).
  const [personal] = await db.select().from(s.loanProducts).where(and(eq(s.loanProducts.code, "PERSONAL"), eq(s.loanProducts.isActive, true)));
  const [product] = personal ? [personal] : await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, "STAFF-PL"));
  const applicant = await by("adaeze.okafor.dev@example.edu.ng");
  const draft = await apps.saveDraft(db, applicant, {
    productId: product.id, requestedAmount: "1200000", tenorMonths: 12, purpose: "Rent renewal and relocation (development walkthrough)",
    guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"],
  });
  const pdf = Buffer.from("%PDF-1.4\n% development fixture payslip\n%%EOF");
  await storeDocument(db, applicant, { buffer: pdf, fileName: "payslip.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip (fixture)", ownerUserId: applicant.userId, applicationId: draft.id, requirementCode: "PAYSLIP" });
  await apps.submitApplication(db, applicant, draft.id, { termsAccepted: true });
  for (const email of ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"]) {
    const g = await by(email);
    const [row] = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, draft.id), eq(s.applicationGuarantors.guarantorId, g.userId)));
    await respondToGuarantee(db, g, row.id, { decision: "accept", typedName: g.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
  }
  const hr = await by("kunle.adeyemi.dev@example.edu.ng");
  const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, draft.id), eq(s.applicationGuarantors.status, "accepted")));
  await recordHrDecision(db, hr, draft.id, {
    outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true,
    monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", notes: "Fixture verification against (simulated) payroll records.",
    guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })),
  });
  await reviewByBursary(db, await by("chioma.nnaji.dev@example.edu.ng"), draft.id, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
  // Head of Mass Communication, then the HR Director, then the Bursar's final approval.
  await decideApplication(db, await by("funmi.adebayo.dev@example.edu.ng"), draft.id, { decision: "approved", comments: "Supported by the department (development walkthrough)." });
  await decideApplication(db, await by("halima.musa.dev@example.edu.ng"), draft.id, { decision: "approved", comments: "Employment in good standing (development walkthrough)." });
  const { loan } = await decideApplication(db, await by("bisi.lawal.dev@example.edu.ng"), draft.id, { decision: "approved", comments: "Approved (development walkthrough)." });
  // The Accounts Payable Officer's payout activates the loan.
  await loans.recordDisbursement(db, await by("chidi.obi.dev@example.edu.ng"), loan!.id, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "DEV-FT-0001", amountDisbursed: loan!.principal, idempotencyKey: "dev-walkthrough-1" });
  await loans.submitRepaymentClaim(db, applicant, loan!.id, { amount: loan!.monthlyInstalment, deductionMonth: todayLagos().slice(0, 7), channel: "payroll" });
  console.log(`Walkthrough complete: application ${draft.reference} → loan ${loan!.accountNumber} (active, one deduction claim pending).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
