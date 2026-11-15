import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  loanAccounts, loanApplications, loanAgreements, disbursements, repaymentSchedules, scheduleInstalments, repaymentClaims,
  financialTransactions, ledgerEntries, restructureRequests, users, staffProfiles, applicationGuarantors, loanProducts, documents,
  notifications, emailOutbox, sessions, rateLimits, earlyRepayments, auditLogs,
} from "@/db/schema";
import { buildSchedule, quoteLoan, instalmentLabel, rescheduleRemaining, PERIOD_MONTHS, type EligibilityResult } from "@/lib/finance/calculator";
import { dec, m, sum, formatNaira, D } from "@/lib/finance/money";
import { addDays, addMonths, firstDueDate, todayLagos, firstOfMonth, formatDate } from "@/lib/finance/dates";
import { sha256Hex } from "@/lib/security/crypto";
import { humanise } from "@/lib/text";
import { assertCan, can, type Actor } from "../actor";
import { audit } from "../audit";
import { notify } from "../notifications";
import { getSetting, getSettings } from "../settings";
import { ageMinutes } from "./reminders";
import { PdfBuilder } from "../pdf";
import { getBranding } from "../branding";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import { getPolicyVersion, getActiveTerms } from "./policies";
import { storeDocument } from "./documents";
import { assertFundsFor } from "./funds";
import { confirmWithCode } from "./mfa";
import { remindWaitingWork } from "./reminders";
import { storage } from "../storage";
import {
  createTransaction, approveTransactionTx, rejectTransactionTx, recomputeLoan, repaymentLines, settlementQuote, settlementLines,
  maxLedgerId, currentSchedule, loanGuarantorIds, notifyPending, accountBalances, endOfMonth, dueNowThrough, type Txn, type Line,
} from "./ledger";
import { monthsText } from "@/lib/finance/dates";

type Loan = typeof loanAccounts.$inferSelect;

async function getLoan(db: Executor, id: string, lock = false): Promise<Loan> {
  const q = db.select().from(loanAccounts).where(eq(loanAccounts.id, id));
  const [loan] = lock ? await q.for("update") : await q;
  if (!loan) throw new NotFoundError("Loan account");
  return loan;
}

function naira(v: string | number) { return formatNaira(v).replace("₦", "NGN "); }

/* ───────────────────────── Origination (on final approval) ───────────────────────── */

export async function createLoanAccount(db: Executor, actor: Actor, app: typeof loanApplications.$inferSelect, approvedAmount: string, tenorMonths: number) {
  const policy = await getPolicyVersion(db, app.policyVersionId);
  const p = policy.params;
  const period = PERIOD_MONTHS[p.repaymentFrequency];
  const quote = quoteLoan(approvedAmount, tenorMonths, p.interestMethod, p.annualInterestRate, null, period);
  const accountNumber = app.reference; // one tracking reference for the request and its loan
  const [loan] = await db.insert(loanAccounts).values({
    accountNumber, applicationId: app.id, borrowerId: app.applicantId, productId: app.productId, policyVersionId: app.policyVersionId,
    status: "pending_disbursement", principal: quote.principal, interestMethod: p.interestMethod, annualInterestRate: String(p.annualInterestRate),
    tenorMonths, repaymentPeriodMonths: period, totalInterest: quote.totalInterest, totalFees: "0.00", totalRepayable: quote.totalRepayable,
    monthlyInstalment: quote.monthlyInstalment, approvedById: actor.userId, approvedAt: new Date(),
  }).returning();
  await audit(db, actor, { action: "loan.created", entityType: "loan_account", entityId: loan.id, summary: `${accountNumber} opened for ${app.reference}`, after: { principal: quote.principal, tenorMonths, totalRepayable: quote.totalRepayable, policyVersion: policy.version } });
  await generateAgreements(db, actor, loan, app);
  return loan;
}

async function generateAgreements(db: Executor, actor: Actor, loan: Loan, app: typeof loanApplications.$inferSelect) {
  const [borrower] = await db.select().from(users).where(eq(users.id, loan.borrowerId));
  const [product] = await db.select().from(loanProducts).where(eq(loanProducts.id, loan.productId));
  const policy = await getPolicyVersion(db, loan.policyVersionId);
  const terms = await getActiveTerms(db, "loan_terms");
  const gTerms = await getActiveTerms(db, "guarantor_agreement");
  const quote = quoteLoan(loan.principal, loan.tenorMonths, policy.params.interestMethod, policy.params.annualInterestRate, null, loan.repaymentPeriodMonths);
  const guarantors = await db.select({ g: applicationGuarantors, name: users.displayName, email: users.email }).from(applicationGuarantors)
    .innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
    .where(and(eq(applicationGuarantors.applicationId, app.id), eq(applicationGuarantors.status, "accepted")));

  const brand = await getBranding(db);
  const pdf = await PdfBuilder.create(db, { kind: "loan_agreement", title: "Staff Loan Agreement", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber} | Terms v${terms?.version ?? "-"} | Policy ${product.code} v${policy.version}` });
  pdf.summary([
    { label: "Principal approved", value: naira(loan.principal) }, { label: "Total repayable", value: naira(loan.totalRepayable) },
    { label: instalmentLabel(loan.repaymentPeriodMonths), value: naira(loan.monthlyInstalment) }, { label: "Tenor", value: `${monthsText(loan.tenorMonths)}` },
  ], [], "Key facts");
  pdf.heading("Parties");
  pdf.keyValues([["Lender", brand.institutionName], ["Borrower", `${borrower.displayName} (${borrower.email})`], ["Approved on", formatDate(loan.approvedAt)]]);
  pdf.heading("Loan particulars");
  pdf.keyValues([
    ["Product", product.name], ["Principal approved", naira(loan.principal)], ["Interest method", policy.params.interestMethod.replace("_", " ")],
    ["Annual interest rate", `${loan.annualInterestRate}%`], ["Total interest", naira(loan.totalInterest)],
    ["Amount to be paid to the borrower", naira(loan.principal)], ["Total repayable", naira(loan.totalRepayable)],
    ["Tenor", `${monthsText(loan.tenorMonths)} (${quote.instalmentCount} instalments)`], [instalmentLabel(loan.repaymentPeriodMonths), naira(loan.monthlyInstalment)],
    ["Repayment method", `Salary deduction on or about day ${policy.params.repaymentDayOfMonth} of the month in which each instalment falls due`],
  ]);
  pdf.heading("Indicative repayment schedule");
  pdf.text("Due dates are fixed when the loan is disbursed.", { size: 8 });
  pdf.table(["#", "Principal", "Interest", "Instalment", "Balance"], quote.schedule.map((l) => [String(l.sequence), naira(l.principalDue), naira(l.interestDue), naira(l.totalDue), naira(l.closingBalance)]), ["left", "right", "right", "right", "right"]);
  if (guarantors.length) {
    pdf.heading("Guarantors");
    pdf.table(["Guarantor", "Email", "Amount guaranteed", "Accepted"], guarantors.map((g) => [g.name, g.email, naira(g.g.guaranteedAmount), formatDate(g.g.respondedAt)]));
  }
  pdf.heading("Terms and conditions");
  pdf.text(terms?.body ?? "Terms not published.", { size: 9 });
  pdf.heading("Acceptance");
  pdf.keyValues([["Terms accepted electronically", `${formatDate(app.termsAcceptedAt)} by ${borrower.displayName}`]]);
  pdf.signatureBlock([`This agreement was produced by the ${brand.systemName} from the approved application record.`, "Its SHA-256 fingerprint is recorded on the loan account and in the document register for integrity verification."]);
  const bytes = await pdf.finish(db, actor, { entityType: "loan_account", entityId: loan.id, loanAccountId: loan.id, subjectUserId: loan.borrowerId });
  const doc = await storeDocument(db, actor, { buffer: bytes, fileName: `${loan.accountNumber}-loan-agreement.pdf`, mimeType: "application/pdf", category: "loan_agreement", title: "Loan agreement", ownerUserId: loan.borrowerId, applicationId: app.id, loanAccountId: loan.id, isSystemGenerated: true });
  await db.insert(loanAgreements).values({ loanAccountId: loan.id, type: "loan", partyUserId: loan.borrowerId, termsDocumentId: terms?.id ?? null, contentHash: sha256Hex(bytes), documentId: doc.id });

  for (const g of guarantors) {
    const gp = await PdfBuilder.create(db, { kind: "guarantor_agreement", title: "Guarantor Agreement", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber} | Agreement v${g.g.agreementVersion ?? gTerms?.version ?? "-"}` });
    gp.heading("Guarantee");
    gp.keyValues([
      ["Guarantor", `${g.name} (${g.email})`], ["Borrower", borrower.displayName], ["Loan principal", naira(loan.principal)],
      ["Total repayable", naira(loan.totalRepayable)], ["Amount guaranteed", naira(g.g.guaranteedAmount)], ["Tenor", `${monthsText(loan.tenorMonths)}`],
    ]);
    gp.heading("Electronic acknowledgement");
    gp.keyValues([
      ["Signed name", g.g.acknowledgedName ?? "-"], ["Account", g.g.acknowledgedEmail ?? "-"], ["Timestamp", g.g.respondedAt?.toISOString() ?? "-"],
      ["IP address", g.g.acknowledgedIp ?? "-"], ["Agreement version", String(g.g.agreementVersion ?? "-")], ["Acknowledgement hash", g.g.acknowledgementHash ?? "-"],
    ]);
    gp.heading("Agreement");
    gp.text(gTerms?.body ?? "", { size: 9 });
    const gb = await gp.finish(db, actor, { entityType: "application_guarantor", entityId: g.g.id, loanAccountId: loan.id, subjectUserId: g.g.guarantorId });
    const gdoc = await storeDocument(db, actor, { buffer: gb, fileName: `${loan.accountNumber}-guarantor-${g.g.id.slice(0, 8)}.pdf`, mimeType: "application/pdf", category: "guarantor_agreement", title: `Guarantor agreement: ${g.name}`, ownerUserId: g.g.guarantorId, applicationId: app.id, loanAccountId: loan.id, applicationGuarantorId: g.g.id, isSystemGenerated: true });
    await db.insert(loanAgreements).values({ loanAccountId: loan.id, type: "guarantor", partyUserId: g.g.guarantorId, termsDocumentId: g.g.agreementTermsId, contentHash: sha256Hex(gb), documentId: gdoc.id });
  }
}

/* ───────────────────────── Disbursement (maker-checker) ───────────────────────── */

export interface DisbursementInput {
  paymentDate: string;
  paymentMethod: (typeof disbursements.$inferInsert)["paymentMethod"];
  transactionReference: string;
  amountDisbursed: string;
  notes?: string;
  idempotencyKey: string;
  evidence?: { buffer: Buffer; fileName: string; mimeType: string } | null;
}

export async function recordDisbursement(db: Executor, actor: Actor, loanId: string, input: DisbursementInput) {
  assertCan(actor, "disbursement.record");
  const ref = input.transactionReference.trim();
  if (ref.length < 4) throw new DomainError("Enter the bank transaction reference.");
  if (input.paymentDate > todayLagos()) throw new DomainError("Payment date cannot be in the future.");
  return db.transaction(async (tx) => {
    const [dupKey] = await tx.select().from(disbursements).where(eq(disbursements.idempotencyKey, input.idempotencyKey));
    if (dupKey) return dupKey;
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError("You cannot disburse your own loan.");
    if (loan.status !== "pending_disbursement") throw new DomainError("This loan is not awaiting disbursement.");
    const [live] = await tx.select().from(disbursements).where(and(eq(disbursements.loanAccountId, loanId), sql`${disbursements.status} <> 'rejected'`));
    if (live) throw new DomainError("A disbursement has already been recorded for this loan.");
    const [refDup] = await tx.select({ id: disbursements.id }).from(disbursements).where(eq(disbursements.transactionReference, ref));
    if (refDup) throw new DomainError(`Bank reference "${ref}" has already been used for another disbursement.`);

    const policy = await getPolicyVersion(tx, loan.policyVersionId);
    if (!dec(input.amountDisbursed).equals(dec(loan.principal))) {
      throw new DomainError(`The amount disbursed must equal the approved amount of ${naira(loan.principal)}.`);
    }
    const [app] = await tx.select({ advanceType: loanApplications.advanceType }).from(loanApplications).where(eq(loanApplications.id, loan.applicationId));
    await assertFundsFor(tx, { amount: loan.principal, isAdvance: !!app?.advanceType, stage: "payout", year: Number(input.paymentDate.slice(0, 4)) });
    const [profile] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, loan.borrowerId));
    const [borrower] = await tx.select().from(users).where(eq(users.id, loan.borrowerId));
    if (!profile?.bankAccountLast4 || !profile.bankName) throw new DomainError("The borrower has not provided bank details. Ask them to update their profile before disbursement.");

    let evidenceId: string | null = null;
    if (input.evidence) {
      const doc = await storeDocument(tx, actor, { ...input.evidence, category: "disbursement_evidence", title: "Disbursement evidence", loanAccountId: loan.id, applicationId: loan.applicationId });
      evidenceId = doc.id;
    }
    const [d] = await tx.insert(disbursements).values({
      loanAccountId: loan.id, approvedAmount: loan.principal, feesDeducted: "0.00", amountDisbursed: m(input.amountDisbursed),
      paymentDate: input.paymentDate, paymentMethod: input.paymentMethod, transactionReference: ref,
      beneficiaryName: profile.bankAccountName ?? borrower.displayName, beneficiaryBank: profile.bankName, beneficiaryAccountLast4: profile.bankAccountLast4,
      evidenceDocumentId: evidenceId, notes: input.notes?.trim() || null, recordedBy: actor.userId, idempotencyKey: input.idempotencyKey,
    }).returning();
    await audit(tx, actor, { action: "disbursement.recorded", entityType: "disbursement", entityId: d.id, summary: `${loan.accountNumber}: ${naira(d.amountDisbursed)} ref ${ref}` });

    // The Accounts Payable Officer's payment activates the loan straight away.
    await postDisbursement(tx, actor, d.id);
    return d;
  });
}

/** Posts a recorded payout: ledger entries, the repayment schedule, the advice and the notifications. */
async function postDisbursement(db: Executor, actor: Actor, disbursementId: string) {
  const [d] = await db.select().from(disbursements).where(eq(disbursements.id, disbursementId)).for("update");
  if (!d) throw new NotFoundError("Disbursement");
  if (d.status !== "pending_confirmation") throw new DomainError("This disbursement has already been processed.");
  const loan = await getLoan(db, d.loanAccountId, true);
  if (loan.borrowerId === actor.userId) throw new ForbiddenError("You cannot confirm your own loan's disbursement.");
  const policy = await getPolicyVersion(db, loan.policyVersionId);
  const p = policy.params;
  const receivable = dec(loan.principal);

  const { txn } = await createTransaction(db, actor, {
    loanAccountId: loan.id, type: "disbursement", amount: d.amountDisbursed, valueDate: d.paymentDate,
    narration: `Disbursement of ${loan.accountNumber} via ${d.paymentMethod.replace("_", " ")}`, externalReference: d.transactionReference,
    idempotencyKey: `disbursement:${d.id}`, requireApproval: false, makerId: d.recordedBy, checkerId: null,
    lines: [
      { account: "loan_principal", direction: "debit", amount: m(receivable) },
      { account: "cash_bank", direction: "credit", amount: d.amountDisbursed },
    ],
  });
  if (dec(loan.totalInterest).greaterThan(0)) {
    await createTransaction(db, actor, {
      loanAccountId: loan.id, type: "interest_recognition", amount: loan.totalInterest, valueDate: d.paymentDate,
      narration: `Contractual interest on ${loan.accountNumber} (${loan.interestMethod.replace("_", " ")}, ${loan.annualInterestRate}% p.a.)`,
      idempotencyKey: `interest:${loan.id}:1`, requireApproval: false,
      lines: [{ account: "interest_receivable", direction: "debit", amount: loan.totalInterest }, { account: "unearned_interest", direction: "credit", amount: loan.totalInterest }],
    });
  }
  // Fix the schedule's real due dates now that the payment date is known.
  const first = firstDueDate(d.paymentDate, p.repaymentDayOfMonth, p.gracePeriodMonths);
  const lines = buildSchedule(loan.principal, loan.tenorMonths, p.interestMethod, p.annualInterestRate, first, loan.repaymentPeriodMonths);
  const [schedule] = await db.insert(repaymentSchedules).values({ loanAccountId: loan.id, version: 1, isCurrent: true, reason: "origination", basePrincipal: m(receivable), ledgerWatermark: await maxLedgerId(db, loan.id), createdBy: actor.userId }).returning();
  await db.insert(scheduleInstalments).values(lines.map((l) => ({ scheduleId: schedule.id, loanAccountId: loan.id, sequence: l.sequence, dueDate: l.dueDate!, principalDue: l.principalDue, interestDue: l.interestDue, totalDue: l.totalDue, openingBalance: l.openingBalance, closingBalance: l.closingBalance })));
  await db.update(disbursements).set({ status: "confirmed", confirmedBy: actor.userId, confirmedAt: new Date(), transactionId: txn.id }).where(eq(disbursements.id, d.id));
  await db.update(loanAccounts).set({ status: "active", disbursedAt: new Date(`${d.paymentDate}T12:00:00Z`), firstDueDate: first, maturityDate: lines.at(-1)!.dueDate }).where(eq(loanAccounts.id, loan.id));
  await recomputeLoan(db, actor, loan.id);
  await audit(db, actor, { action: "disbursement.confirmed", entityType: "disbursement", entityId: d.id, summary: `${loan.accountNumber} disbursed; schedule v1 active from ${first}` });

  // Disbursement advice
  const [borrower] = await db.select().from(users).where(eq(users.id, loan.borrowerId));
  const pdf = await PdfBuilder.create(db, { kind: "disbursement_advice", title: "Disbursement Advice", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber} | Paid ${formatDate(txn.valueDate)}` });
  pdf.summary([
    { label: "Amount paid", value: naira(d.amountDisbursed) }, { label: "Payment date", value: formatDate(d.paymentDate) },
    { label: "First repayment due", value: formatDate(first) }, { label: instalmentLabel(loan.repaymentPeriodMonths), value: naira(loan.monthlyInstalment) },
  ], [], "Key facts");
  pdf.keyValues([
    ["Beneficiary", `${d.beneficiaryName}, ${d.beneficiaryBank} ****${d.beneficiaryAccountLast4}`], ["Borrower", borrower.displayName],
    ["Approved amount", naira(d.approvedAmount)], ["Amount disbursed", naira(d.amountDisbursed)],
    ["Payment date", formatDate(d.paymentDate)], ["Payment method", d.paymentMethod.replace("_", " ")], ["Bank reference", d.transactionReference],
    ["First repayment due", formatDate(first)], [instalmentLabel(loan.repaymentPeriodMonths), naira(loan.monthlyInstalment)], ["Final repayment due", formatDate(lines.at(-1)!.dueDate)],
  ]);
  pdf.heading("Repayment schedule");
  pdf.table(["#", "Due date", "Principal", "Interest", "Instalment", "Balance"], lines.map((l) => [String(l.sequence), formatDate(l.dueDate), naira(l.principalDue), naira(l.interestDue), naira(l.totalDue), naira(l.closingBalance)]), ["left", "left", "right", "right", "right", "right"]);
  await storeDocument(db, actor, { buffer: await pdf.finish(db, actor, { entityType: "disbursement", entityId: d.id, loanAccountId: loan.id, subjectUserId: loan.borrowerId }), fileName: `${loan.accountNumber}-disbursement-advice.pdf`, mimeType: "application/pdf", category: "statement", title: "Disbursement advice", ownerUserId: loan.borrowerId, loanAccountId: loan.id, applicationId: loan.applicationId, isSystemGenerated: true });

  const guarantors = await loanGuarantorIds(db, loan.applicationId);
  await notify(db, { template: "loan.disbursed", userIds: [loan.borrowerId, ...guarantors], link: `/loans/${loan.id}`, vars: { accountNumber: loan.accountNumber, amount: naira(d.amountDisbursed), date: formatDate(d.paymentDate), txnRef: d.transactionReference, instalment: naira(loan.monthlyInstalment), firstDue: formatDate(first) } });
  return txn;
}

/* ───────────────────────── Repayments ───────────────────────── */

const SERVICEABLE = ["active", "overdue", "defaulted"] as const;

export async function submitRepaymentClaim(db: Executor, actor: Actor, loanId: string, input: { amount: string; deductionMonth: string; channel: "payroll" | "bank_transfer"; payerReference?: string; note?: string; evidence?: { buffer: Buffer; fileName: string; mimeType: string } | null }) {
  assertCan(actor, "repayment.claim");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId);
    if (loan.borrowerId !== actor.userId) throw new ForbiddenError();
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("Repayments can only be reported on active loans.");
    if (loan.deductionsConfirmedAt) throw new DomainError("Deductions on this loan are recorded automatically each month, so there is nothing to report.");
    if (dec(input.amount).lessThanOrEqualTo(0)) throw new DomainError("Enter the amount deducted or paid.");
    const month = firstOfMonth(`${input.deductionMonth}-01`.slice(0, 10));
    if (month > todayLagos()) throw new DomainError("You cannot report a deduction for a future month.");
    const [pending] = await tx.select({ id: repaymentClaims.id }).from(repaymentClaims).where(and(eq(repaymentClaims.loanAccountId, loanId), eq(repaymentClaims.deductionMonth, month), eq(repaymentClaims.status, "pending")));
    if (pending) throw new DomainError("You already have a pending report for that month. Wait for the Payroll Officer to confirm it.");
    let evidenceId: string | null = null;
    if (input.evidence) evidenceId = (await storeDocument(tx, actor, { ...input.evidence, category: "repayment_evidence", title: `Repayment evidence ${month.slice(0, 7)}`, ownerUserId: actor.userId, loanAccountId: loanId })).id;
    const [c] = await tx.insert(repaymentClaims).values({ loanAccountId: loanId, claimedBy: actor.userId, amount: m(input.amount), deductionMonth: month, channel: input.channel, payerReference: input.payerReference?.trim() || null, note: input.note?.trim() || null, evidenceDocumentId: evidenceId }).returning();
    await audit(tx, actor, { action: "repayment.claim_submitted", entityType: "repayment_claim", entityId: c.id, summary: `${loan.accountNumber}: ${naira(c.amount)} for ${month.slice(0, 7)} (pending confirmation)` });
    await notify(tx, { template: "repayment.claim_submitted", roles: ["PAYROLL_OFFICER"], excludeUserIds: [actor.userId], link: `/accounts/repayments`, vars: { applicantName: actor.displayName, amount: naira(c.amount), month: month.slice(0, 7), accountNumber: loan.accountNumber } });
    return c;
  });
}

async function afterRepaymentPosted(db: Executor, actor: Actor, txn: Txn) {
  // Which instalments this payment was for, judged before it is allocated (as when its lines were built).
  const before = await currentSchedule(db, txn.loanAccountId);
  const through = before ? dueNowThrough(before.instalments, txn.valueDate) : 0;
  await recomputeLoan(db, actor, txn.loanAccountId);
  // A payment beyond what is due reduces principal: re-schedule the months left on the new balance.
  await rescheduleToBalance(db, actor, txn.loanAccountId, through);
  const result = await recomputeLoan(db, actor, txn.loanAccountId);
  const [claim] = await db.select().from(repaymentClaims).where(eq(repaymentClaims.transactionId, txn.id));
  if (claim && claim.status === "pending") {
    await db.update(repaymentClaims).set({ status: "confirmed", reviewedAt: new Date() }).where(eq(repaymentClaims.id, claim.id));
  }
  const loan = await getLoan(db, txn.loanAccountId);
  await notify(db, { template: "repayment.confirmed", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, vars: { amount: naira(txn.amount), accountNumber: loan.accountNumber, outstanding: naira(result.outstanding) } });
}

/**
 * Re-schedule the months left when the principal balance no longer matches the schedule: after a part
 * prepayment, or a principal adjustment. Instalments up to `through` (those the payment was for) stay as they
 * are, with any unpaid part carried into the new schedule; the rest are rebuilt on the principal balance, over
 * the same months and due dates, with interest recalculated on it:
 *
 *   New interest        = interest on the new balance over the months left (reducing balance: level
 *                         repayments at the monthly rate; flat: new balance x annual rate x months left / 12)
 *   Interest released   = interest still to come on the old schedule - new interest
 *
 * The interest released is written off from unearned interest in the ledger (or, after a reversal, the extra
 * interest is recognised). Where the product gives no early-repayment rebate, the interest is kept.
 */
export async function rescheduleToBalance(db: Executor, actor: Actor, loanId: string, through: number) {
  const loan = await getLoan(db, loanId);
  if (!SERVICEABLE.includes(loan.status as never)) return null;
  const cur = await currentSchedule(db, loanId);
  if (!cur) return null;
  const open = cur.instalments.filter((i) => i.status !== "superseded");
  const dueNow = open.filter((i) => i.sequence <= through);
  const later = open.filter((i) => i.sequence > through);
  if (!later.length) return null;
  const unpaid = (due: string, paid: string) => D.max(0, dec(due).minus(paid));
  const carried = dueNow.map((i) => ({ i, principal: unpaid(i.principalDue, i.principalPaid), interest: unpaid(i.interestDue, i.interestPaid) }))
    .filter((c) => c.principal.plus(c.interest).greaterThan(0));
  const bal = await accountBalances(db, loanId);
  const balance = D.max(0, bal.principal.minus(sum(carried.map((c) => c.principal))));
  if (balance.minus(sum(later.map((i) => i.principalDue))).abs().lessThan("0.01")) return null; // schedule already matches
  const futureInterest = D.max(0, bal.interest.minus(sum(carried.map((c) => c.interest))));

  const p = (await getPolicyVersion(db, loan.policyVersionId)).params;
  const months = later.length * loan.repaymentPeriodMonths;
  const lines = balance.greaterThan(0)
    ? rescheduleRemaining(balance, months, p.interestMethod, p.annualInterestRate, later[0].dueDate, loan.repaymentPeriodMonths, p.earlySettlementRebate === "none" ? futureInterest : undefined)
    : [];
  const newInterest = sum(lines.map((l) => l.interestDue));
  const delta = newInterest.minus(futureInterest);
  if (!delta.isZero()) {
    const released = delta.lessThan(0);
    const amount = m(delta.abs());
    await createTransaction(db, actor, {
      loanAccountId: loan.id, type: released ? "interest_rebate" : "interest_recognition", amount, valueDate: todayLagos(),
      narration: released ? `Interest recalculated on the reduced balance of ${naira(m(balance))}: ${naira(amount)} no longer charged` : `Interest recalculated on the balance of ${naira(m(balance))}`,
      idempotencyKey: `reschedule:${loan.id}:${await maxLedgerId(db, loan.id)}`, requireApproval: false,
      lines: released
        ? [{ account: "unearned_interest", direction: "debit", amount }, { account: "interest_receivable", direction: "credit", amount }]
        : [{ account: "interest_receivable", direction: "debit", amount }, { account: "unearned_interest", direction: "credit", amount }],
    });
  }
  await supersedeSchedule(db, cur.schedule.id, open.map((i) => i.id));
  const [ns] = await db.insert(repaymentSchedules).values({
    loanAccountId: loan.id, version: cur.schedule.version + 1, isCurrent: true, reason: "prepayment",
    basePrincipal: m(balance.plus(sum(carried.map((c) => c.principal)))), ledgerWatermark: await maxLedgerId(db, loan.id), createdBy: actor.userId,
  }).returning();
  const rows = [
    ...carried.map((c) => ({ sequence: c.i.sequence, dueDate: c.i.dueDate, principalDue: m(c.principal), interestDue: m(c.interest), totalDue: m(c.principal.plus(c.interest)), openingBalance: m(balance.plus(c.principal)), closingBalance: m(balance) })),
    ...lines.map((l, k) => ({ sequence: later[0].sequence + k, dueDate: l.dueDate!, principalDue: l.principalDue, interestDue: l.interestDue, totalDue: l.totalDue, openingBalance: l.openingBalance, closingBalance: l.closingBalance })),
  ];
  if (rows.length) await db.insert(scheduleInstalments).values(rows.map((r) => ({ scheduleId: ns.id, loanAccountId: loan.id, ...r })));
  const fresh = await getLoan(db, loan.id);
  await db.update(loanAccounts).set({
    monthlyInstalment: lines[0]?.totalDue ?? fresh.monthlyInstalment,
    totalInterest: m(dec(fresh.totalInterest).plus(delta)), totalRepayable: m(dec(fresh.totalRepaid).plus(sum(rows.map((r) => r.totalDue)))),
  }).where(eq(loanAccounts.id, loan.id));
  await audit(db, actor, { action: "loan.rescheduled", entityType: "loan_account", entityId: loan.id, summary: `${loan.accountNumber}: schedule v${ns.version}, balance ${m(balance)} over ${monthsText(months)}, interest ${delta.lessThan(0) ? "released" : "added"} ${m(delta.abs())}` });
  if (lines.length) await notify(db, { template: "loan.rescheduled", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, vars: { accountNumber: loan.accountNumber, amount: naira(lines[0].totalDue), tenor: months } });
  return ns;
}

/** Bring the schedule back in line with the balance after a posted reversal or principal adjustment. */
export async function realignSchedule(db: Executor, actor: Actor, loanId: string) {
  return db.transaction(async (tx) => {
    await recomputeLoan(tx, actor, loanId);
    if (await rescheduleToBalance(tx, actor, loanId, await dueThroughToday(tx, loanId))) await recomputeLoan(tx, actor, loanId);
  });
}

/**
 * For re-scheduling outside a payment: the instalments that stay as they are, being those due by the end of
 * this month and those already paid in full by repayments (adjustments and waivers do not count as paying an
 * instalment; they reduce the balance that is re-scheduled).
 */
async function dueThroughToday(db: Executor, loanId: string) {
  const cur = await currentSchedule(db, loanId);
  if (!cur) return 0;
  const [row] = await db.select({
    paid: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)`,
  }).from(ledgerEntries).innerJoin(financialTransactions, eq(financialTransactions.id, ledgerEntries.transactionId)).where(and(
    eq(ledgerEntries.loanAccountId, loanId),
    sql`${ledgerEntries.id} > ${cur.schedule.ledgerWatermark}`,
    inArray(ledgerEntries.account, ["loan_principal", "interest_receivable"]),
    sql`(${financialTransactions.type} = 'repayment' or (${financialTransactions.type} = 'reversal' and exists (select 1 from financial_transactions o where o.id = ${financialTransactions.reversesTransactionId} and o.type = 'repayment')))`,
  ));
  let paid = D.max(0, dec(row?.paid ?? 0));
  const cutoff = endOfMonth(todayLagos());
  let through = 0;
  for (const i of cur.instalments.filter((x) => x.status !== "superseded").sort((a, b) => a.sequence - b.sequence)) {
    const covered = paid.greaterThanOrEqualTo(i.totalDue);
    paid = D.max(0, paid.minus(i.totalDue));
    if (i.dueDate <= cutoff || covered) through = i.sequence; else break;
  }
  return through;
}

/** Retire a schedule and its open instalments. */
async function supersedeSchedule(db: Executor, scheduleId: string, instalmentIds: string[]) {
  if (instalmentIds.length) await db.update(scheduleInstalments).set({ status: "superseded" }).where(and(eq(scheduleInstalments.scheduleId, scheduleId), inArray(scheduleInstalments.id, instalmentIds), inArray(scheduleInstalments.status, ["pending", "partial", "overdue"])));
  await db.update(repaymentSchedules).set({ isCurrent: false }).where(eq(repaymentSchedules.id, scheduleId));
}

export async function confirmRepaymentClaim(db: Executor, actor: Actor, claimId: string, input: { amount: string; valueDate: string; bankReference: string; comment?: string }) {
  assertCan(actor, "repayment.confirm");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(repaymentClaims).where(eq(repaymentClaims.id, claimId)).for("update");
    if (!c) throw new NotFoundError("Repayment claim");
    if (c.status !== "pending" || c.transactionId) throw new DomainError("This claim has already been processed.");
    if (c.claimedBy === actor.userId) throw new ForbiddenError("You cannot confirm your own repayment report.");
    const loan = await getLoan(tx, c.loanAccountId, true);
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("This loan is not in a serviceable state.");
    if (input.valueDate > todayLagos()) throw new DomainError("Value date cannot be in the future.");
    const requireApproval = await getSetting(tx, "finance.makerChecker.repayment");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "repayment", amount: m(input.amount), valueDate: input.valueDate,
      narration: `Repayment ${c.channel === "payroll" ? "salary deduction" : "transfer"} for ${c.deductionMonth.slice(0, 7)} (claim confirmed)`,
      externalReference: input.bankReference.trim() || `CLAIM-${c.id}`, idempotencyKey: `claim:${c.id}`,
      lines: await repaymentLines(tx, loan.id, m(input.amount), input.valueDate), requireApproval,
    });
    await tx.update(repaymentClaims).set({ transactionId: txn.id, reviewedBy: actor.userId, reviewComment: input.comment?.trim() || null, ...(txn.status === "posted" ? { status: "confirmed" as const, reviewedAt: new Date() } : {}) }).where(eq(repaymentClaims.id, c.id));
    if (txn.status === "posted") await afterRepaymentPosted(tx, actor, txn);
    else await notifyPending(tx, actor, txn);
    if (c.channel === "payroll" && !loan.deductionsConfirmedAt) await startAutomaticDeductions(tx, actor, loan);
    return txn;
  });
}

/**
 * Once the Payroll Officer has confirmed a salary deduction, the University deducts the instalment
 * from every salary until the loan is repaid, so later instalments are recorded on their due dates
 * without the borrower reporting them (see runServicing).
 */
async function startAutomaticDeductions(db: Executor, actor: Actor, loan: Loan) {
  await db.update(loanAccounts).set({ deductionsConfirmedAt: new Date(), deductionsConfirmedBy: actor.userId }).where(eq(loanAccounts.id, loan.id));
  await audit(db, actor, { action: "loan.deductions_automatic", entityType: "loan_account", entityId: loan.id, summary: `${loan.accountNumber}: first salary deduction confirmed; later instalments are recorded automatically on their due dates` });
  await notify(db, { template: "repayment.deductions_automatic", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, vars: { accountNumber: loan.accountNumber, instalment: naira(loan.monthlyInstalment) } });
}

/** Instalments due by `asOf` on loans with automatic deductions, recorded as deducted from salary on their due dates. */
async function postAutomaticDeductions(db: Executor, loan: Loan, asOf: string) {
  if (!loan.deductionsConfirmedAt || !loan.deductionsConfirmedBy) return 0;
  // Not while the borrower is repaying the whole balance early: the quote they paid against must not change.
  const [early] = await db.select({ id: earlyRepayments.id }).from(earlyRepayments).where(and(eq(earlyRepayments.loanAccountId, loan.id), eq(earlyRepayments.status, "pending")));
  if (early) return 0;
  const from = loan.deductionsConfirmedAt.toISOString().slice(0, 10);
  const cur = await currentSchedule(db, loan.id);
  const [officer] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, loan.deductionsConfirmedBy));
  // Recorded on the standing confirmation of the Payroll Officer who confirmed the first deduction.
  const actor: Actor = { userId: loan.deductionsConfirmedBy, email: officer?.email ?? "", displayName: `${officer?.name ?? "Payroll Officer"} (automatic deduction)`, roles: [], permissions: new Set() };
  let posted = 0;
  for (const i of cur?.instalments ?? []) {
    if (i.status === "paid" || i.status === "superseded" || i.dueDate > asOf || i.dueDate < from) continue;
    const amount = dec(i.totalDue).minus(i.principalPaid).minus(i.interestPaid);
    if (amount.lessThanOrEqualTo(0)) continue;
    const month = new Date(`${i.dueDate}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const { txn, duplicate } = await createTransaction(db, actor, {
      loanAccountId: loan.id, type: "repayment", amount: m(amount), valueDate: i.dueDate,
      narration: `Salary deduction for ${month} (automatic)`, externalReference: `PAYROLL-${i.dueDate.slice(0, 7)}`, idempotencyKey: `auto-deduction:${i.id}`,
      lines: await repaymentLines(db, loan.id, m(amount), i.dueDate), requireApproval: false,
    });
    if (duplicate) continue;
    await afterRepaymentPosted(db, actor, txn);
    posted++;
  }
  return posted;
}

export async function rejectRepaymentClaim(db: Executor, actor: Actor, claimId: string, reason: string) {
  assertCan(actor, "repayment.confirm");
  if (reason.trim().length < 3) throw new DomainError("Give a reason so the staff member knows what to do next.");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(repaymentClaims).where(eq(repaymentClaims.id, claimId)).for("update");
    if (!c || c.status !== "pending" || c.transactionId) throw new DomainError("This claim is not awaiting review.");
    if (c.claimedBy === actor.userId) throw new ForbiddenError();
    const loan = await getLoan(tx, c.loanAccountId);
    await tx.update(repaymentClaims).set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: reason.trim() }).where(eq(repaymentClaims.id, c.id));
    await audit(tx, actor, { action: "repayment.claim_rejected", entityType: "repayment_claim", entityId: c.id, summary: reason });
    await notify(tx, { template: "repayment.claim_rejected", userIds: [c.claimedBy], link: `/loans/${loan.id}`, vars: { amount: naira(c.amount), month: c.deductionMonth.slice(0, 7), accountNumber: loan.accountNumber, comment: reason.trim() } });
  });
}

/** Direct repayment entry by the Bursary (e.g. payroll deduction schedule, bank receipt) without a staff claim. */
export async function recordRepayment(db: Executor, actor: Actor, loanId: string, input: { amount: string; valueDate: string; reference: string; channel: string; idempotencyKey: string; guarantorId?: string | null }) {
  assertCan(actor, "repayment.confirm");
  if (!input.reference.trim()) throw new DomainError("A bank or payroll reference is required.");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError("You cannot post repayments to your own loan.");
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("This loan is not in a serviceable state.");
    if (input.valueDate > todayLagos()) throw new DomainError("Value date cannot be in the future.");
    let payer = "";
    if (input.guarantorId) {
      // Recovery from a guarantor under their agreement (default management).
      if (!(await loanGuarantorIds(tx, loan.applicationId)).includes(input.guarantorId)) throw new DomainError("That person is not an accepted guarantor on this loan.");
      if (input.guarantorId === actor.userId) throw new ForbiddenError("You cannot record a recovery from yourself.");
      const [g] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, input.guarantorId));
      payer = `, recovery from guarantor ${g.name}`;
    }
    const requireApproval = await getSetting(tx, "finance.makerChecker.repayment");
    const { txn, duplicate } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "repayment", amount: m(input.amount), valueDate: input.valueDate,
      narration: `Repayment received (${input.channel.replace("_", " ")})${payer}`, externalReference: input.reference.trim(), idempotencyKey: input.idempotencyKey,
      lines: await repaymentLines(tx, loan.id, m(input.amount), input.valueDate), requireApproval,
    });
    if (duplicate) return txn;
    // Auto-match a pending staff claim for the same month and amount.
    const month = firstOfMonth(input.valueDate);
    const [claim] = await tx.select().from(repaymentClaims).where(and(eq(repaymentClaims.loanAccountId, loan.id), eq(repaymentClaims.deductionMonth, month), eq(repaymentClaims.status, "pending"), sql`${repaymentClaims.transactionId} is null`, eq(repaymentClaims.amount, m(input.amount))));
    if (claim) await tx.update(repaymentClaims).set({ transactionId: txn.id, reviewedBy: actor.userId, reviewComment: "Matched to recorded repayment" }).where(eq(repaymentClaims.id, claim.id));
    if (txn.status === "posted") await afterRepaymentPosted(tx, actor, txn);
    else await notifyPending(tx, actor, txn);
    return txn;
  });
}

/* ───────────────────────── Early repayment ───────────────────────── */

/**
 * Repaying early is always the whole balance (part payments come only from salary):
 *   Amount = principal still owed (after repayments) + interest to date on the reducing balance - credit already paid
 * where interest to date is the unpaid interest on instalments already due plus the current instalment's
 * interest for the days elapsed in its period. Interest for the remaining months is not charged.
 */
export async function earlyRepaymentQuote(db: Executor, loanId: string, asOf = todayLagos()) {
  const q = await settlementQuote(db, loanId, asOf, { rebateFutureInterest: true });
  return { ...q, interestSaved: q.rebate };
}

export async function earlyRepaymentAccount(db: Executor) {
  const s = await getSettings(db, ["earlyRepayment.bankName", "earlyRepayment.accountName", "earlyRepayment.accountNumber"]);
  const account = { bankName: s["earlyRepayment.bankName"], accountName: s["earlyRepayment.accountName"], accountNumber: s["earlyRepayment.accountNumber"] };
  return { ...account, ready: !!(account.bankName && account.accountName && account.accountNumber) };
}

/** The borrower has paid the whole balance by transfer and sends the receipt for the Payroll Officer to check. */
export async function requestEarlyRepayment(db: Executor, actor: Actor, loanId: string, input: { payerReference?: string; receipt: { buffer: Buffer; fileName: string; mimeType: string } | null }) {
  assertCan(actor, "repayment.claim");
  const receipt = input.receipt;
  if (!receipt) throw new DomainError("Upload the receipt for your payment.");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId !== actor.userId) throw new ForbiddenError();
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("Only an active loan can be repaid early.");
    const [app] = await tx.select({ advanceType: loanApplications.advanceType }).from(loanApplications).where(eq(loanApplications.id, loan.applicationId));
    if (app?.advanceType) throw new DomainError("An advance is recovered from the payment it was taken against, so it cannot be repaid early.");
    if (!(await earlyRepaymentAccount(tx)).ready) throw new DomainError("The account for early repayments has not been set up yet. Please contact the Bursary.");
    const [pending] = await tx.select({ id: earlyRepayments.id }).from(earlyRepayments).where(and(eq(earlyRepayments.loanAccountId, loan.id), eq(earlyRepayments.status, "pending")));
    if (pending) throw new DomainError("You have already sent an early repayment for this loan. The Payroll Officer will confirm it.");
    const q = await earlyRepaymentQuote(tx, loan.id);
    if (dec(q.settlementAmount).lessThanOrEqualTo(0)) throw new DomainError("Nothing is left to repay on this loan.");
    const doc = await storeDocument(tx, actor, { ...receipt, category: "repayment_evidence", title: "Early repayment receipt", ownerUserId: actor.userId, loanAccountId: loan.id, applicationId: loan.applicationId });
    const [r] = await tx.insert(earlyRepayments).values({
      loanAccountId: loan.id, requestedBy: actor.userId, quoteDate: q.asOf, amount: q.settlementAmount, principal: q.loanPrincipal, interest: q.interestToDate ?? q.interestDue,
      interestSaved: q.interestSaved, payerReference: input.payerReference?.trim() || null, receiptDocumentId: doc.id,
    }).returning();
    await audit(tx, actor, { action: "repayment.early_submitted", entityType: "early_repayment", entityId: r.id, summary: `${loan.accountNumber}: early repayment of ${naira(r.amount)} sent for confirmation` });
    await notify(tx, { template: "repayment.early_submitted", roles: ["PAYROLL_OFFICER"], excludeUserIds: [actor.userId], link: `/payroll/early-repayments/${r.id}`, vars: { applicantName: actor.displayName, amount: naira(r.amount), accountNumber: loan.accountNumber } });
    return r;
  });
}

/**
 * The Payroll Officer has seen the money arrive and closes the loan as repaid in full, entering a fresh
 * code from their authenticator app first, because the loan closes at once.
 */
export async function confirmEarlyRepayment(db: Executor, actor: Actor, requestId: string, input: { code: string }) {
  assertCan(actor, "settlement.confirm");
  await confirmWithCode(db, actor, input.code, "mark a loan repaid in full");
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(earlyRepayments).where(eq(earlyRepayments.id, requestId)).for("update");
    if (!r) throw new NotFoundError("Early repayment");
    if (r.status !== "pending") throw new DomainError("This early repayment has already been dealt with.");
    const loan = await getLoan(tx, r.loanAccountId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError("You cannot confirm the repayment of your own loan.");
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("This loan is no longer active.");
    const q = await earlyRepaymentQuote(tx, loan.id, r.quoteDate);
    if (!dec(q.settlementAmount).equals(r.amount)) {
      throw new DomainError(`The balance has changed since the borrower's quote of ${naira(r.amount)} on ${formatDate(r.quoteDate)}; it is now ${naira(q.settlementAmount)}. Decline this request and ask the borrower to start again.`);
    }
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "early_settlement", amount: m(dec(q.principal).plus(q.interestDue).plus(q.rebate)), valueDate: r.quoteDate,
      narration: `Repaid in full early (paid ${naira(q.settlementAmount)}, interest not charged ${naira(q.rebate)})`,
      externalReference: r.payerReference, idempotencyKey: `early-repayment:${r.id}`,
      lines: settlementLines(q, q.settlementAmount), requireApproval: false,
    });
    await afterRepaymentPosted(tx, actor, txn);
    await tx.update(earlyRepayments).set({ status: "confirmed", reviewedBy: actor.userId, reviewedAt: new Date(), transactionId: txn.id }).where(eq(earlyRepayments.id, r.id));
    await audit(tx, actor, { action: "repayment.early_confirmed", entityType: "early_repayment", entityId: r.id, summary: `${loan.accountNumber}: repaid in full early (${naira(r.amount)}); confirmed with a two-step verification code` });
    await notify(tx, { template: "repayment.early_confirmed", userIds: [loan.borrowerId, ...(await loanGuarantorIds(tx, loan.applicationId))], link: `/loans/${loan.id}`, vars: { amount: naira(r.amount), accountNumber: loan.accountNumber } });
    return txn;
  });
}

export async function declineEarlyRepayment(db: Executor, actor: Actor, requestId: string, reason: string) {
  assertCan(actor, "settlement.confirm");
  if (reason.trim().length < 5) throw new DomainError("Give a reason so the borrower knows what to do next.");
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(earlyRepayments).where(eq(earlyRepayments.id, requestId)).for("update");
    if (!r || r.status !== "pending") throw new DomainError("This early repayment is not awaiting confirmation.");
    const loan = await getLoan(tx, r.loanAccountId);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    await tx.update(earlyRepayments).set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: reason.trim() }).where(eq(earlyRepayments.id, r.id));
    await audit(tx, actor, { action: "repayment.early_declined", entityType: "early_repayment", entityId: r.id, summary: `${loan.accountNumber}: ${reason.trim()}` });
    await notify(tx, { template: "repayment.early_declined", userIds: [r.requestedBy], link: `/loans/${loan.id}`, vars: { amount: naira(r.amount), accountNumber: loan.accountNumber, comment: reason.trim() } });
  });
}

/** Early repayments for the Payroll Officer and Payroll Manager: those waiting first, then the most recent. */
export async function earlyRepaymentList(db: Executor, actor: Actor) {
  assertCan(actor, "payroll.view");
  return db.select({ r: earlyRepayments, accountNumber: loanAccounts.accountNumber, borrower: users.displayName })
    .from(earlyRepayments).innerJoin(loanAccounts, eq(loanAccounts.id, earlyRepayments.loanAccountId)).innerJoin(users, eq(users.id, earlyRepayments.requestedBy))
    .orderBy(sql`case when ${earlyRepayments.status} = 'pending' then 0 else 1 end`, desc(earlyRepayments.createdAt));
}

export async function getEarlyRepayment(db: Executor, actor: Actor, id: string) {
  assertCan(actor, "payroll.view");
  const [row] = await db.select({ r: earlyRepayments, loan: loanAccounts, borrower: users.displayName, email: users.email })
    .from(earlyRepayments).innerJoin(loanAccounts, eq(loanAccounts.id, earlyRepayments.loanAccountId)).innerJoin(users, eq(users.id, earlyRepayments.requestedBy))
    .where(eq(earlyRepayments.id, id));
  if (!row) throw new NotFoundError("Early repayment");
  const [reviewer] = row.r.reviewedBy ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, row.r.reviewedBy)) : [];
  return { ...row, reviewer: reviewer?.name ?? null };
}

/* ───────────────────────── Settlement, waivers, refunds ───────────────────────── */

/**
 * Not offered to staff: a loan is repaid by monthly deduction over the tenor chosen, so no screen or action
 * calls this. It remains only so a loan can be closed in automated tests.
 */
export async function proposeEarlySettlement(db: Executor, actor: Actor, loanId: string, input: { amountReceived: string; valueDate: string; reference: string }) {
  assertCan(actor, "transaction.adjust");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("Only active loans can be settled early.");
    const q = await settlementQuote(tx, loanId);
    if (!dec(input.amountReceived).equals(q.settlementAmount)) throw new DomainError(`The settlement amount today is ${naira(q.settlementAmount)}. Record exactly that amount (use an ordinary repayment for part-payments).`);
    const requireApproval = await getSetting(tx, "finance.makerChecker.adjustment");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "early_settlement", amount: m(dec(q.principal).plus(q.interestDue).plus(q.rebate)), valueDate: input.valueDate,
      narration: `Early settlement (cash ${naira(q.settlementAmount)}, interest rebate ${naira(q.rebate)}, credit applied ${naira(q.overpaymentCredit)})`,
      externalReference: input.reference.trim() || null, idempotencyKey: `settlement:${loan.id}:${loan.rowVersion}`,
      lines: settlementLines(q, q.settlementAmount), requireApproval,
    });
    if (txn.status === "posted") await afterRepaymentPosted(tx, actor, txn);
    else await notifyPending(tx, actor, txn);
    return txn;
  });
}

export async function proposeWaiver(db: Executor, actor: Actor, loanId: string, input: { component: "principal" | "interest"; amount: string; reason: string }) {
  assertCan(actor, "transaction.adjust");
  if (input.reason.trim().length < 10) throw new DomainError("Document the reason and authority for this adjustment (at least 10 characters).");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    const bal = await accountBalances(tx, loanId);
    const limit = input.component === "principal" ? bal.principal : bal.interest;
    if (dec(input.amount).lessThanOrEqualTo(0) || dec(input.amount).greaterThan(limit)) throw new DomainError(`Adjustment must be between 0 and the outstanding ${input.component} of ${naira(m(limit))}.`);
    const account = input.component === "principal" ? "loan_principal" : "interest_receivable";
    const requireApproval = await getSetting(tx, "finance.makerChecker.adjustment");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "adjustment", amount: m(input.amount), valueDate: todayLagos(),
      narration: `Waiver of ${input.component}: ${input.reason.trim()}`, idempotencyKey: `adj:${loan.id}:${loan.rowVersion}:${input.component}:${m(input.amount)}`,
      lines: [{ account: "adjustments", direction: "debit", amount: m(input.amount) }, { account, direction: "credit", amount: m(input.amount) }], requireApproval,
    });
    if (txn.status === "posted") await recomputeLoan(tx, actor, loan.id); else await notifyPending(tx, actor, txn);
    return txn;
  });
}

export async function proposeRefund(db: Executor, actor: Actor, loanId: string, input: { amount: string; reference: string }) {
  assertCan(actor, "transaction.adjust");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    const bal = await accountBalances(tx, loanId);
    if (dec(input.amount).lessThanOrEqualTo(0) || dec(input.amount).greaterThan(bal.overpayment)) throw new DomainError(`Refund cannot exceed the overpayment balance of ${naira(m(bal.overpayment))}.`);
    const requireApproval = await getSetting(tx, "finance.makerChecker.adjustment");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "refund", amount: m(input.amount), valueDate: todayLagos(), narration: "Refund of overpayment to borrower",
      externalReference: input.reference.trim() || null, idempotencyKey: `refund:${loan.id}:${loan.rowVersion}:${m(input.amount)}`,
      lines: [{ account: "overpayment_liability", direction: "debit", amount: m(input.amount) }, { account: "cash_bank", direction: "credit", amount: m(input.amount) }], requireApproval,
    });
    if (txn.status === "posted") await recomputeLoan(tx, actor, loan.id); else await notifyPending(tx, actor, txn);
    return txn;
  });
}

/* ───────────────────────── Default management ───────────────────────── */

/** Formally call on the accepted guarantors of a defaulted loan, each for their pro-rata share of what is outstanding. */
export async function callOnGuarantors(db: Executor, actor: Actor, loanId: string, comment: string) {
  assertCan(actor, "transaction.adjust");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    if (loan.status !== "defaulted") throw new DomainError("Guarantors can only be called upon once a loan is classified as in default.");
    const guarantees = await tx.select({ g: applicationGuarantors, name: users.displayName }).from(applicationGuarantors)
      .innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
      .where(and(eq(applicationGuarantors.applicationId, loan.applicationId), eq(applicationGuarantors.status, "accepted")));
    if (!guarantees.length) throw new DomainError("This loan has no accepted guarantors.");
    const [borrower] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, loan.borrowerId));
    const outstanding = dec(loan.principalOutstanding).plus(loan.interestOutstanding);
    const totalGuaranteed = sum(guarantees.map((g) => g.g.guaranteedAmount));
    for (const { g } of guarantees) {
      // Share of the outstanding balance, capped at what each guarantor agreed to guarantee.
      const share = D.min(dec(g.guaranteedAmount), totalGuaranteed.isZero() ? dec(0) : outstanding.times(g.guaranteedAmount).div(totalGuaranteed));
      await notify(tx, {
        template: "guarantor.called", userIds: [g.guarantorId], link: `/guarantor/requests/${g.id}`, dedupeKey: `called:${loan.id}:${todayLagos()}`,
        vars: { accountNumber: loan.accountNumber, applicantName: borrower.name, days: loan.daysPastDue, amount: naira(m(share)), outstanding: naira(m(outstanding)), comment },
      });
    }
    await audit(tx, actor, { action: "loan.guarantors_called", entityType: "loan_account", entityId: loan.id, summary: `${loan.accountNumber}: ${guarantees.length} guarantor(s) called upon. ${comment}`, after: { outstanding: m(outstanding), guarantors: guarantees.map((x) => x.name) } });
    return guarantees.length;
  });
}

/** Write off the full outstanding balance of a defaulted loan (maker-checker via the adjustment setting). Reversible to reinstate. */
export async function proposeWriteOff(db: Executor, actor: Actor, loanId: string, reason: string) {
  assertCan(actor, "transaction.adjust");
  if (reason.trim().length < 15) throw new DomainError("Record the reason and the approving authority for the write-off (at least 15 characters).");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    if (loan.status !== "defaulted") throw new DomainError("Only loans classified as in default can be written off.");
    const [pending] = await tx.select({ ref: financialTransactions.reference }).from(financialTransactions)
      .where(and(eq(financialTransactions.loanAccountId, loanId), eq(financialTransactions.type, "write_off"), eq(financialTransactions.status, "pending_approval")));
    if (pending) throw new DomainError(`A write-off (${pending.ref}) is already awaiting approval.`);
    const bal = await accountBalances(tx, loanId);
    const total = bal.principal.plus(bal.interest);
    if (total.lessThanOrEqualTo(0)) throw new DomainError("Nothing outstanding to write off.");
    const requireApproval = await getSetting(tx, "finance.makerChecker.adjustment");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: loan.id, type: "write_off", amount: m(total), valueDate: todayLagos(),
      narration: `Write-off of defaulted balance: ${reason.trim()}`, idempotencyKey: `writeoff:${loan.id}:${loan.rowVersion}`, requireApproval,
      lines: [
        { account: "adjustments", direction: "debit", amount: m(total) },
        { account: "loan_principal", direction: "credit", amount: m(D.max(0, bal.principal)) },
        { account: "interest_receivable", direction: "credit", amount: m(D.max(0, bal.interest)) },
      ],
    });
    if (txn.status === "posted") await recomputeLoan(tx, actor, loan.id); else await notifyPending(tx, actor, txn);
    return txn;
  });
}

/** Checker approval for any pending transaction, recomputing receipt splits against the current state. */
export async function approvePendingTransaction(db: Executor, actor: Actor, txnId: string) {
  assertCan(actor, "transaction.approve");
  return db.transaction(async (tx) => {
    const [pending] = await tx.select().from(financialTransactions).where(eq(financialTransactions.id, txnId));
    if (!pending) throw new NotFoundError("Transaction");
    const loan = await getLoan(tx, pending.loanAccountId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError("You cannot approve transactions on your own loan.");
    let recompute: ((t: Txn) => Promise<Line[]>) | undefined;
    if (pending.type === "repayment") recompute = (t) => repaymentLines(tx, t.loanAccountId, t.amount, t.valueDate);
    if (pending.type === "early_settlement") {
      recompute = async (t) => {
        const q = await settlementQuote(tx, t.loanAccountId);
        const proposedCash = (t.proposedEntries as Line[]).find((l) => l.account === "cash_bank")?.amount ?? "0";
        if (!dec(proposedCash).equals(q.settlementAmount)) throw new DomainError("The loan balance changed since this settlement was proposed. Reject it and record a new settlement.");
        return settlementLines(q, q.settlementAmount);
      };
    }
    const txn = await approveTransactionTx(tx, actor, txnId, recompute);
    if (txn.type === "repayment" || txn.type === "early_settlement") await afterRepaymentPosted(tx, actor, txn);
    else {
      await recomputeLoan(tx, actor, txn.loanAccountId);
      // A reversed repayment or a principal adjustment changes the balance the schedule is built on.
      if ((txn.type === "reversal" || txn.type === "adjustment") && await rescheduleToBalance(tx, actor, txn.loanAccountId, await dueThroughToday(tx, txn.loanAccountId))) await recomputeLoan(tx, actor, txn.loanAccountId);
    }
    return txn;
  });
}

export async function rejectPendingTransaction(db: Executor, actor: Actor, txnId: string, reason: string) {
  assertCan(actor, "transaction.approve");
  return db.transaction(async (tx) => {
    const txn = await rejectTransactionTx(tx, actor, txnId, reason);
    // A rejected repayment releases its claim back to the review queue.
    await tx.update(repaymentClaims).set({ transactionId: null, reviewedBy: null, reviewComment: `Previous confirmation rejected by checker: ${reason}` })
      .where(and(eq(repaymentClaims.transactionId, txn.id), eq(repaymentClaims.status, "pending")));
    return txn;
  });
}

/* ───────────────────────── Restructuring ───────────────────────── */

export async function requestRestructure(db: Executor, actor: Actor, loanId: string, input: { proposedTenorMonths: number; reason: string }) {
  assertCan(actor, "restructure.request");
  return db.transaction(async (tx) => {
    const loan = await getLoan(tx, loanId);
    if (loan.borrowerId !== actor.userId) throw new ForbiddenError();
    if (!SERVICEABLE.includes(loan.status as never)) throw new DomainError("Only active loans can be restructured.");
    const p = (await getPolicyVersion(tx, loan.policyVersionId)).params;
    if (!p.allowRestructuring) throw new DomainError("This loan product does not permit restructuring.");
    if (!Number.isInteger(input.proposedTenorMonths) || input.proposedTenorMonths < 1 || input.proposedTenorMonths > p.maxRestructuredTenorMonths) throw new DomainError(`The proposed remaining tenor must be between 1 and ${monthsText(p.maxRestructuredTenorMonths)}.`);
    if (input.proposedTenorMonths % loan.repaymentPeriodMonths !== 0) throw new DomainError(`The proposed tenor must be a multiple of ${monthsText(loan.repaymentPeriodMonths)} (this loan's repayment frequency).`);
    if (input.reason.trim().length < 10) throw new DomainError("Explain why you need the loan restructured.");
    const [r] = await tx.insert(restructureRequests).values({ loanAccountId: loanId, requestedBy: actor.userId, proposedTenorMonths: input.proposedTenorMonths, reason: input.reason.trim() }).returning();
    await audit(tx, actor, { action: "restructure.requested", entityType: "restructure_request", entityId: r.id, summary: `${loan.accountNumber}: ${monthsText(input.proposedTenorMonths)}` });
    await notify(tx, { template: "restructure.requested", roles: ["ACCOUNTS_ADMIN"], link: `/accounts/loans/${loan.id}`, vars: { applicantName: actor.displayName, accountNumber: loan.accountNumber, tenor: input.proposedTenorMonths, comment: input.reason.trim() } });
    return r;
  });
}

export async function decideRestructure(db: Executor, actor: Actor, requestId: string, approve: boolean, comment: string) {
  assertCan(actor, "restructure.approve");
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(restructureRequests).where(eq(restructureRequests.id, requestId)).for("update");
    if (!r || r.status !== "pending") throw new DomainError("This request is not pending.");
    const loan = await getLoan(tx, r.loanAccountId, true);
    if (loan.borrowerId === actor.userId) throw new ForbiddenError();
    if (!approve) {
      await tx.update(restructureRequests).set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: comment }).where(eq(restructureRequests.id, r.id));
      await audit(tx, actor, { action: "restructure.rejected", entityType: "restructure_request", entityId: r.id, summary: comment });
      await notify(tx, { template: "restructure.decided", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, vars: { accountNumber: loan.accountNumber, decision: "declined", comment } });
      return null;
    }
    const p = (await getPolicyVersion(tx, loan.policyVersionId)).params;
    await recomputeLoan(tx, actor, loan.id);
    const bal = await accountBalances(tx, loan.id);
    const cur = await currentSchedule(tx, loan.id);
    if (!cur) throw new DomainError("Loan has no schedule to restructure.");
    const today = todayLagos();
    // Interest already due but unpaid is capitalised; interest not yet due is released.
    const dueUnpaidInterest = sum(cur.instalments.filter((i) => i.dueDate <= today).map((i) => D.max(0, dec(i.interestDue).minus(i.interestPaid))));
    const capitalised = D.min(dueUnpaidInterest, D.max(0, bal.interest));
    const released = D.max(0, bal.interest.minus(capitalised));
    if (bal.interest.greaterThan(0)) {
      await createTransaction(tx, actor, {
        loanAccountId: loan.id, type: "interest_rebate", amount: m(bal.interest), valueDate: today,
        narration: `Restructure: release unearned interest ${naira(m(released))}, capitalise overdue interest ${naira(m(capitalised))}`,
        idempotencyKey: `restructure-release:${r.id}`, requireApproval: false,
        lines: [
          { account: "unearned_interest", direction: "debit", amount: m(released) },
          { account: "loan_principal", direction: "debit", amount: m(capitalised) },
          { account: "interest_receivable", direction: "credit", amount: m(bal.interest) },
        ],
      });
    }
    const base = bal.principal.plus(capitalised);
    if (base.lessThanOrEqualTo(0)) throw new DomainError("Nothing outstanding to restructure.");
    const first = firstDueDate(today, p.repaymentDayOfMonth, 0);
    const lines = buildSchedule(base, r.proposedTenorMonths, p.interestMethod, p.annualInterestRate, first, loan.repaymentPeriodMonths);
    const newInterest = sum(lines.map((l) => l.interestDue));
    if (newInterest.greaterThan(0)) {
      await createTransaction(tx, actor, {
        loanAccountId: loan.id, type: "interest_recognition", amount: m(newInterest), valueDate: today, narration: `Restructured interest over ${monthsText(r.proposedTenorMonths)}`,
        idempotencyKey: `interest:${loan.id}:restructure:${r.id}`, requireApproval: false,
        lines: [{ account: "interest_receivable", direction: "debit", amount: m(newInterest) }, { account: "unearned_interest", direction: "credit", amount: m(newInterest) }],
      });
    }
    await tx.update(scheduleInstalments).set({ status: "superseded" }).where(and(eq(scheduleInstalments.scheduleId, cur.schedule.id), inArray(scheduleInstalments.status, ["pending", "partial", "overdue"])));
    await tx.update(repaymentSchedules).set({ isCurrent: false }).where(eq(repaymentSchedules.id, cur.schedule.id));
    const [ns] = await tx.insert(repaymentSchedules).values({ loanAccountId: loan.id, version: cur.schedule.version + 1, isCurrent: true, reason: "restructure", basePrincipal: m(base), ledgerWatermark: await maxLedgerId(tx, loan.id), createdBy: actor.userId }).returning();
    await tx.insert(scheduleInstalments).values(lines.map((l) => ({ scheduleId: ns.id, loanAccountId: loan.id, sequence: l.sequence, dueDate: l.dueDate!, principalDue: l.principalDue, interestDue: l.interestDue, totalDue: l.totalDue, openingBalance: l.openingBalance, closingBalance: l.closingBalance })));
    const totalRepayable = dec(loan.totalRepaid).plus(sum(lines.map((l) => l.totalDue)));
    await tx.update(loanAccounts).set({ monthlyInstalment: lines[0].totalDue, maturityDate: lines.at(-1)!.dueDate, totalRepayable: m(totalRepayable), totalInterest: m(dec(loan.totalInterest).minus(released).plus(newInterest)) }).where(eq(loanAccounts.id, loan.id));
    await tx.update(restructureRequests).set({ status: "approved", reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: comment, newScheduleId: ns.id }).where(eq(restructureRequests.id, r.id));
    await recomputeLoan(tx, actor, loan.id);
    await audit(tx, actor, { action: "restructure.approved", entityType: "loan_account", entityId: loan.id, summary: `${loan.accountNumber}: schedule v${ns.version}, ${monthsText(r.proposedTenorMonths)} from ${first}, base ${m(base)}` });
    await notify(tx, { template: "restructure.decided", userIds: [loan.borrowerId, ...(await loanGuarantorIds(tx, loan.applicationId))], link: `/loans/${loan.id}`, vars: { accountNumber: loan.accountNumber, decision: "approved", comment: `New monthly instalment ${naira(lines[0].totalDue)} from ${formatDate(first)} for ${monthsText(r.proposedTenorMonths)}. ${comment}` } });
    return ns;
  });
}

/* ───────────────────────── Servicing job ───────────────────────── */

/** Daily: refresh statuses/DPD, send due-date reminders, flag overdue and defaulted loans. */
export async function runServicing(db: Executor, actor: Actor | null, asOf = todayLagos()) {
  const live = await db.select().from(loanAccounts).where(inArray(loanAccounts.status, [...SERVICEABLE]));
  let reminders = 0, deductions = 0;
  const changes: string[] = [];
  for (const loan of live) {
    await db.transaction(async (tx) => {
      deductions += await postAutomaticDeductions(tx, loan, asOf);
      const res = await recomputeLoan(tx, actor, loan.id, asOf);
      if (res.status !== res.previous) changes.push(`${loan.accountNumber}: ${res.previous} → ${res.status}`);
      const p = (await getPolicyVersion(tx, loan.policyVersionId)).params;
      const cur = await currentSchedule(tx, loan.id);
      for (const i of cur?.instalments ?? []) {
        if (i.status === "paid" || i.status === "superseded") continue;
        const until = (Date.parse(i.dueDate) - Date.parse(asOf)) / 86_400_000;
        if (until >= 0 && until <= p.reminderDaysBeforeDue) {
          const remaining = m(dec(i.totalDue).minus(i.principalPaid).minus(i.interestPaid));
          await notify(tx, { template: "repayment.reminder", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, dedupeKey: `reminder:${i.id}`, vars: { amount: naira(remaining), date: formatDate(i.dueDate), sequence: i.sequence, accountNumber: loan.accountNumber } });
          reminders++;
        }
      }
    });
  }
  const deductionAlerts = await alertDeductions(db, asOf);
  const guarantorReminders = await remindGuarantors(db, asOf);
  const work = await remindWaitingWork(db, asOf);
  const purged = await housekeeping(db);
  await audit(db, actor, {
    action: "servicing.run", entityType: "system",
    summary: `As of ${asOf}: ${live.length} loans checked, ${deductions} automatic deductions, ${deductionAlerts} deduction alerts, ${changes.length} status changes, ${reminders} repayment reminders, ${guarantorReminders} guarantor reminders, ${work.reminders} work reminders, ${work.escalations} overdue alerts; housekeeping removed ${purged.notifications} notifications, ${purged.sessions} sessions, ${purged.emails} sent emails, ${purged.rateLimits} rate-limit rows`,
    after: { checked: live.length, deductions, changes, reminders, guarantorReminders, workReminders: work.reminders, escalations: work.escalations, purged },
  });
  return { checked: live.length, deductions, changes, reminders, guarantorReminders, workReminders: work.reminders, escalations: work.escalations, purged, asOf };
}

/**
 * Whether the automatic loan check is due: the scheduler calls every hour, and the check runs only when the
 * time set by the administrator has passed since the last automatic run. A few minutes early counts, so a run
 * that took a little longer last time does not push the next one back an hour.
 */
export async function automaticCheckDue(db: Executor, now = new Date()): Promise<{ due: boolean; nextAfter: string | null }> {
  const every = await getSetting(db, "automation.checkEveryMinutes");
  const [last] = await db.select({ at: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.action, "servicing.run"), sql`${auditLogs.actorId} is null`)).orderBy(desc(auditLogs.id)).limit(1);
  if (!last) return { due: true, nextAfter: null };
  const next = new Date(new Date(last.at).getTime() + (every - 5) * 60_000);
  return { due: now >= next, nextAfter: next.toISOString() };
}

/** The reminders alone, so they can run more often than the full loan check. */
export async function runReminders(db: Executor, asOf = todayLagos()) {
  const guarantorReminders = await remindGuarantors(db, asOf);
  const work = await remindWaitingWork(db, asOf);
  return { guarantorReminders, workReminders: work.reminders, escalations: work.escalations };
}

/**
 * Salary deductions around each due date:
 *  - on the due date, the Payroll Officer is told what is due that day;
 *  - a day after it, for a loan whose first deduction has not been confirmed (so not yet automatic),
 *    the Payroll Officer and Payroll Manager are told it is still unconfirmed, and the borrower is asked
 *    to report it if it has been deducted.
 * Each alert is sent once (dedupe keys); only instalments due in the last month are considered.
 */
async function alertDeductions(db: Executor, asOf: string) {
  const since = addDays(asOf, -31);
  const rows = await db.select({ i: scheduleInstalments, loan: loanAccounts, borrower: users.displayName })
    .from(scheduleInstalments).innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
    .innerJoin(loanAccounts, eq(loanAccounts.id, scheduleInstalments.loanAccountId)).innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .where(and(eq(repaymentSchedules.isCurrent, true), inArray(loanAccounts.status, [...SERVICEABLE]), sql`${scheduleInstalments.dueDate} between ${since} and ${asOf}`));
  let sent = 0;

  // Due today: one note per due date for the Payroll Officer.
  const today = rows.filter((r) => r.i.dueDate === asOf);
  if (today.length) {
    const automatic = today.filter((r) => r.loan.deductionsConfirmedAt).length;
    await notify(db, {
      template: "payroll.deductions_due", roles: ["PAYROLL_OFFICER"], link: "/payroll", dedupeKey: `deductions-due:${asOf}`,
      vars: { count: today.length, amount: naira(m(sum(today.map((r) => r.i.totalDue)))), date: formatDate(asOf), automatic, toConfirm: today.length - automatic },
    });
    sent++;
  }

  // A day after the due date and still not confirmed.
  const late = rows.filter((r) => !r.loan.deductionsConfirmedAt && r.i.status !== "paid" && r.i.status !== "superseded" && r.i.dueDate <= addDays(asOf, -1));
  for (const { i, loan, borrower } of late) {
    const remaining = naira(m(dec(i.totalDue).minus(i.principalPaid).minus(i.interestPaid)));
    const vars = { applicantName: borrower, amount: remaining, date: formatDate(i.dueDate), accountNumber: loan.accountNumber };
    const [reported] = await db.select({ id: repaymentClaims.id }).from(repaymentClaims)
      .where(and(eq(repaymentClaims.loanAccountId, loan.id), eq(repaymentClaims.deductionMonth, firstOfMonth(i.dueDate)), eq(repaymentClaims.status, "pending")));
    if (reported) {
      await notify(db, { template: "repayment.awaiting_confirmation", roles: ["PAYROLL_OFFICER", "PAYROLL_MANAGER"], excludeUserIds: [loan.borrowerId], link: "/accounts/repayments", dedupeKey: `awaiting-confirmation:${i.id}`, vars });
    } else {
      await notify(db, { template: "repayment.unreported", roles: ["PAYROLL_OFFICER", "PAYROLL_MANAGER"], excludeUserIds: [loan.borrowerId], link: "/payroll", dedupeKey: `unreported:${i.id}`, vars });
      await notify(db, { template: "repayment.report_reminder", userIds: [loan.borrowerId], link: `/loans/${loan.id}?tab=report`, dedupeKey: `report-reminder:${i.id}`, vars });
    }
    sent++;
  }
  return sent;
}

/** Remind guarantors who have not responded, once per configured response period. */
async function remindGuarantors(db: Executor, asOf: string) {
  const after = await getSetting(db, "reminders.guarantorMinutes");
  const waiting = await db.select({ g: applicationGuarantors, ref: loanApplications.reference, applicant: users.displayName }).from(applicationGuarantors)
    .innerJoin(loanApplications, eq(loanApplications.id, applicationGuarantors.applicationId))
    .innerJoin(users, eq(users.id, loanApplications.applicantId))
    .where(and(eq(applicationGuarantors.status, "pending"), eq(loanApplications.status, "pending_guarantor")));
  let sent = 0;
  for (const w of waiting) {
    const age = ageMinutes(w.g.invitedAt, asOf);
    if (age < after) continue;
    const period = Math.floor(age / after);
    await notify(db, { template: "guarantor.reminder", userIds: [w.g.guarantorId], link: `/guarantor/requests/${w.g.id}`, dedupeKey: `greminder:${w.g.id}:${period}`, vars: { applicantName: w.applicant, reference: w.ref } });
    sent++;
  }
  return sent;
}

/**
 * Data-minimisation housekeeping (NDPA). Only operational data is purged: read notifications, old
 * session records, delivered email copies and rate-limit buckets. Applications, loans, ledger,
 * documents and audit records are retained under the University's records-retention schedule.
 */
async function housekeeping(db: Executor) {
  const notifMonths = await getSetting(db, "retention.readNotificationsMonths");
  const sessionDays = await getSetting(db, "retention.sessionDays");
  const emailMonths = await getSetting(db, "retention.emailOutboxMonths");
  const e = await db.delete(emailOutbox).where(sql`${emailOutbox.status} in ('sent', 'not_configured', 'failed') and ${emailOutbox.createdAt} < now() - make_interval(months => ${emailMonths})`).returning({ id: emailOutbox.id });
  const n = await db.delete(notifications).where(sql`${notifications.readAt} is not null and ${notifications.createdAt} < now() - make_interval(months => ${notifMonths})
    and not exists (select 1 from email_outbox e where e.notification_id = ${notifications.id})`).returning({ id: notifications.id });
  const s = await db.delete(sessions).where(sql`(${sessions.revokedAt} is not null or ${sessions.expiresAt} < now()) and ${sessions.createdAt} < now() - make_interval(days => ${sessionDays})`).returning({ id: sessions.id });
  const r = await db.delete(rateLimits).where(sql`${rateLimits.windowStart} < now() - interval '1 day'`).returning({ key: rateLimits.key });
  const orphans = await sweepOrphanedFiles(db);
  return { notifications: n.length, emails: e.length, sessions: s.length, rateLimits: r.length, orphanedFiles: orphans };
}

/**
 * Files are written to storage before the database transaction commits; if the transaction rolls
 * back, the encrypted file is left with no document record. Remove such orphans after a day's grace
 * (never touches a file that a document row references).
 */
async function sweepOrphanedFiles(db: Executor) {
  const store = storage();
  let objects: { key: string; modified: Date }[];
  try {
    objects = await store.list();
  } catch {
    return 0; // storage unreachable: the health check will flag it; do not fail the servicing run
  }
  const cutoff = Date.now() - 86_400_000;
  const candidates = objects.filter((o) => o.modified.getTime() < cutoff);
  if (!candidates.length) return 0;
  const known = new Set((await db.select({ k: documents.storageKey }).from(documents)).map((d) => d.k));
  let removed = 0;
  for (const o of candidates) {
    if (known.has(o.key)) continue;
    await store.remove(o.key);
    removed++;
  }
  return removed;
}

/* ───────────────────────── Read models ───────────────────────── */

export async function loanAccess(db: Executor, actor: Actor, loanId: string) {
  const loan = await getLoan(db, loanId);
  const isBorrower = loan.borrowerId === actor.userId;
  const isStaff = can(actor, "accounts.view") || can(actor, "documents.view_all");
  const guarantorIds = await loanGuarantorIds(db, loan.applicationId);
  const isGuarantor = guarantorIds.includes(actor.userId);
  if (!isBorrower && !isStaff && !isGuarantor) throw new ForbiddenError("You do not have access to this loan.");
  return { loan, isBorrower, isStaff, isGuarantor };
}

export async function getLoanDetail(db: Executor, actor: Actor, loanId: string) {
  const access = await loanAccess(db, actor, loanId);
  const { loan } = access;
  const [borrower] = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, loan.borrowerId));
  const [app] = await db.select().from(loanApplications).where(eq(loanApplications.id, loan.applicationId));
  const [product] = await db.select().from(loanProducts).where(eq(loanProducts.id, loan.productId));
  const cur = await currentSchedule(db, loanId);
  const schedules = await db.select().from(repaymentSchedules).where(eq(repaymentSchedules.loanAccountId, loanId)).orderBy(desc(repaymentSchedules.version));
  const txns = await db.select({ t: financialTransactions, makerName: users.displayName }).from(financialTransactions).innerJoin(users, eq(users.id, financialTransactions.makerId)).where(eq(financialTransactions.loanAccountId, loanId)).orderBy(desc(financialTransactions.createdAt));
  const entries = access.isStaff ? await db.select().from(ledgerEntries).where(eq(ledgerEntries.loanAccountId, loanId)).orderBy(asc(ledgerEntries.id)) : [];
  const claims = await db.select().from(repaymentClaims).where(eq(repaymentClaims.loanAccountId, loanId)).orderBy(desc(repaymentClaims.createdAt));
  const disb = await db.select().from(disbursements).where(eq(disbursements.loanAccountId, loanId)).orderBy(desc(disbursements.createdAt));
  const restructures = await db.select().from(restructureRequests).where(eq(restructureRequests.loanAccountId, loanId)).orderBy(desc(restructureRequests.createdAt));
  const agreements = await db.select({ a: loanAgreements, title: documents.title }).from(loanAgreements).leftJoin(documents, eq(documents.id, loanAgreements.documentId)).where(eq(loanAgreements.loanAccountId, loanId));
  const policy = await getPolicyVersion(db, loan.policyVersionId);
  return { ...access, borrower, app, product, policy, schedule: cur, schedules, txns, entries, claims, disbursements: disb, restructures, agreements, quote: app.quote as unknown as EligibilityResult };
}

export async function listMyLoans(db: Executor, actor: Actor) {
  assertCan(actor, "loan.view_own");
  return db.select({ loan: loanAccounts, productName: loanProducts.name }).from(loanAccounts).innerJoin(loanProducts, eq(loanProducts.id, loanAccounts.productId)).where(eq(loanAccounts.borrowerId, actor.userId)).orderBy(desc(loanAccounts.createdAt));
}

/** Monthly reconciliation: expected instalments vs confirmed receipts vs pending staff reports. */
export async function reconciliation(db: Executor, actor: Actor, month: string) {
  assertCan(actor, "accounts.view");
  const start = `${month}-01`;
  const end = addMonths(start, 1);
  const expected = await db.select({ loanId: scheduleInstalments.loanAccountId, due: sql<string>`sum(${scheduleInstalments.totalDue})` }).from(scheduleInstalments)
    .innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
    .where(and(sql`${scheduleInstalments.dueDate} >= ${start} and ${scheduleInstalments.dueDate} < ${end}`, eq(repaymentSchedules.isCurrent, true)))
    .groupBy(scheduleInstalments.loanAccountId);
  const received = await db.select({ loanId: financialTransactions.loanAccountId, amt: sql<string>`sum(${financialTransactions.amount})` }).from(financialTransactions)
    .where(and(inArray(financialTransactions.type, ["repayment"]), eq(financialTransactions.status, "posted"), sql`${financialTransactions.valueDate} >= ${start} and ${financialTransactions.valueDate} < ${end}`,
      sql`not exists (select 1 from financial_transactions r where r.reverses_transaction_id = ${financialTransactions.id} and r.status = 'posted')`))
    .groupBy(financialTransactions.loanAccountId);
  const claims = await db.select({ loanId: repaymentClaims.loanAccountId, amt: sql<string>`sum(${repaymentClaims.amount})`, n: sql<number>`count(*)` }).from(repaymentClaims)
    .where(and(eq(repaymentClaims.deductionMonth, start), eq(repaymentClaims.status, "pending"))).groupBy(repaymentClaims.loanAccountId);
  const ids = [...new Set([...expected, ...received, ...claims].map((r) => r.loanId))];
  if (!ids.length) return [];
  const loans = await db.select({ loan: loanAccounts, borrower: users.displayName, staffNumber: staffProfiles.staffNumber }).from(loanAccounts)
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId)).leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId)).where(inArray(loanAccounts.id, ids));
  return loans.map(({ loan, borrower, staffNumber }) => {
    const e = dec(expected.find((x) => x.loanId === loan.id)?.due ?? 0);
    const r = dec(received.find((x) => x.loanId === loan.id)?.amt ?? 0);
    const c = claims.find((x) => x.loanId === loan.id);
    const variance = r.minus(e);
    return {
      loanId: loan.id, accountNumber: loan.accountNumber, borrower, staffNumber, status: loan.status,
      expected: m(e), received: m(r), pendingClaims: m(c?.amt ?? 0), pendingClaimCount: Number(c?.n ?? 0), variance: m(variance),
      state: variance.isZero() ? "matched" : variance.greaterThan(0) ? "over" : r.isZero() ? (c ? "claimed" : "missing") : "short",
    };
  }).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
}

/** Receipt for one posted repayment / settlement (borrower, guarantors or Accounts). */
export async function receiptPdf(db: Executor, actor: Actor, txnId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const [t] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, txnId));
  if (!t) throw new NotFoundError("Transaction");
  const { loan } = await loanAccess(db, actor, t.loanAccountId);
  if (t.status !== "posted" || !["repayment", "early_settlement"].includes(t.type)) throw new DomainError("Receipts are issued only for posted repayments and settlements.");
  const [reversal] = await db.select({ ref: financialTransactions.reference }).from(financialTransactions).where(and(eq(financialTransactions.reversesTransactionId, t.id), eq(financialTransactions.status, "posted")));
  const lines = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, t.id));
  const part = (acct: string) => m(sum(lines.filter((l) => l.account === acct && l.direction === "credit").map((l) => l.amount)));
  const cash = m(sum(lines.filter((l) => l.account === "cash_bank" && l.direction === "debit").map((l) => l.amount)));
  const [borrower] = await db.select().from(users).where(eq(users.id, loan.borrowerId));
  const brand = await getBranding(db);
  const pdf = await PdfBuilder.create(db, { kind: "receipt", title: reversal ? "Repayment Receipt (REVERSED)" : "Repayment Receipt", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber} | Value date ${formatDate(t.valueDate)}` });
  pdf.summary([
    { label: "Amount received", value: naira(cash), tone: reversal ? "bad" : "good" }, { label: "Value date", value: formatDate(t.valueDate) },
    { label: "Loan reference", value: t.reference }, { label: "Status", value: reversal ? "Reversed" : "Confirmed", tone: reversal ? "bad" : "good" },
  ], [], "Receipt summary");
  if (reversal) pdf.text(`This receipt was reversed by ${reversal.ref} and no longer counts towards the loan balance.`, { bold: true });
  const [staff] = await db.select({ staffNumber: staffProfiles.staffNumber }).from(staffProfiles).where(eq(staffProfiles.userId, loan.borrowerId));
  pdf.heading("Payment details");
  pdf.keyValues([
    ["Received from", borrower.displayName], ["Staff number", staff?.staffNumber ?? "Not recorded"], ["Loan account", loan.accountNumber],
    ["Loan reference", t.reference], ["Value date", formatDate(t.valueDate)], ["Payment reference", t.externalReference ?? "Not recorded"],
    ["Description", t.narration], ["Confirmed on", t.postedAt ? formatDate(t.postedAt) : "Not recorded"],
  ]);
  pdf.heading("Allocation of payment");
  pdf.table(["Applied to", "Amount"], [
    ["Interest", naira(part("interest_receivable"))], ["Principal", naira(part("loan_principal"))], ["Held as overpayment credit", naira(part("overpayment_liability"))],
  ], { align: ["left", "right"], totals: ["Amount received", naira(cash)] });
  pdf.heading("Account position after this payment");
  pdf.keyValues([["Outstanding balance", naira(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding)))], ["Total repaid to date", naira(loan.totalRepaid)], ["Account status", humanise(loan.status)]]);
  pdf.signatureBlock([`Issued by the Bursary, ${brand.institutionName}, from the confirmed loan ledger. This receipt is computer generated and needs no signature.`, `Its authenticity can be confirmed by the Bursary using the document reference in the footer. Balances reflect all confirmed transactions at the time of issue.`]);
  await audit(db, actor, { action: "loan.receipt_generated", entityType: "financial_transaction", entityId: t.id });
  return { bytes: await pdf.finish(db, actor, { entityType: "financial_transaction", entityId: t.id, loanAccountId: loan.id, subjectUserId: loan.borrowerId }), fileName: `${t.reference}-receipt-${t.valueDate}.pdf` };
}

/** Clearance (full settlement) letter for a closed loan; also releases guarantors in writing. */
export async function clearancePdf(db: Executor, actor: Actor, loanId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const { loan } = await loanAccess(db, actor, loanId);
  if (loan.status !== "closed") throw new DomainError("A clearance letter is only available once the loan is fully settled and closed.");
  const [borrower] = await db.select().from(users).where(eq(users.id, loan.borrowerId));
  const guarantors = await db.select({ name: users.displayName }).from(applicationGuarantors).innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
    .where(and(eq(applicationGuarantors.applicationId, loan.applicationId), eq(applicationGuarantors.status, "accepted")));
  const brand = await getBranding(db);
  const pdf = await PdfBuilder.create(db, { kind: "clearance_letter", title: "Loan Clearance Letter", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber}` });
  pdf.text(`This is to confirm that staff loan account ${loan.accountNumber} held by ${borrower.displayName} has been fully repaid and closed on ${formatDate(loan.closedAt)}.`);
  pdf.gap(6);
  pdf.keyValues([
    ["Principal", naira(loan.principal)], ["Total repaid", naira(loan.totalRepaid)], ["Disbursed", formatDate(loan.disbursedAt)], ["Closed", formatDate(loan.closedAt)],
    ["Outstanding balance", naira("0")], ["Overpayment credit held", naira(loan.overpaymentBalance)],
  ]);
  if (guarantors.length) {
    pdf.heading("Guarantors");
    pdf.text(`The obligations of the guarantor(s) under their guarantor agreements for this loan have ended: ${guarantors.map((g) => g.name).join(", ")}.`);
  }
  pdf.signatureBlock([`Issued by the Bursary, ${brand.institutionName}, from the confirmed loan ledger.`]);
  await audit(db, actor, { action: "loan.clearance_generated", entityType: "loan_account", entityId: loan.id });
  return { bytes: await pdf.finish(db, actor, { entityType: "loan_account", entityId: loan.id, loanAccountId: loan.id, subjectUserId: loan.borrowerId }), fileName: `${loan.accountNumber}-clearance.pdf` };
}

/** Loan statement PDF (borrower, guarantors or Accounts). */
export async function statementPdf(db: Executor, actor: Actor, loanId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const d = await getLoanDetail(db, actor, loanId);
  const { loan } = d;
  const pdf = await PdfBuilder.create(db, { kind: "statement", title: "Loan Statement", parent: loan.accountNumber, subtitle: `Reference ${loan.accountNumber} | ${d.borrower.displayName} | as of ${formatDate(new Date())}` });
  const outstanding = m(dec(loan.principalOutstanding).plus(loan.interestOutstanding));
  pdf.summary([
    { label: "Total repayable", value: naira(loan.totalRepayable) }, { label: "Repaid (confirmed)", value: naira(loan.totalRepaid), tone: "good" },
    { label: "Outstanding", value: naira(outstanding), tone: dec(outstanding).isZero() ? "good" : "default" },
    { label: "Days past due", value: String(loan.daysPastDue), tone: loan.daysPastDue > 0 ? "bad" : "good" },
  ], [
    `Status: ${humanise(loan.status).toLowerCase()}. ${loan.maturityDate ? `Final instalment due ${formatDate(loan.maturityDate)}.` : "Repayment dates are fixed when the loan is paid out."}`,
  ]);
  pdf.heading("Account details");
  pdf.keyValues([
    ["Borrower", d.borrower.displayName], ["Product", d.product.name], ["Status", humanise(loan.status)], ["Principal", naira(loan.principal)], ["Total repayable", naira(loan.totalRepayable)],
    ["Total repaid (confirmed)", naira(loan.totalRepaid)], ["Principal outstanding", naira(loan.principalOutstanding)], ["Interest outstanding", naira(loan.interestOutstanding)],
    ["Overpayment credit", naira(loan.overpaymentBalance)], ["Days past due", String(loan.daysPastDue)], ["Maturity date", formatDate(loan.maturityDate)],
  ]);
  pdf.heading("Posted transactions");
  pdf.table(["Date", "Reference", "Type", "Amount", "Narration"], d.txns.filter((t) => t.t.status === "posted" && t.t.type !== "interest_recognition").reverse().map((t) => [formatDate(t.t.valueDate), t.t.reference, humanise(t.t.type), naira(t.t.amount), t.t.narration]), ["left", "left", "left", "right", "left"]);
  if (d.schedule) {
    pdf.heading(`Repayment schedule (version ${d.schedule.schedule.version})`);
    pdf.table(["#", "Due", "Instalment", "Paid", "Status"], d.schedule.instalments.map((i) => [String(i.sequence), formatDate(i.dueDate), naira(i.totalDue), naira(m(dec(i.principalPaid).plus(i.interestPaid))), humanise(i.status)]), {
      align: ["left", "left", "right", "right", "left"],
      totals: ["Total", "", naira(m(sum(d.schedule.instalments.map((i) => i.totalDue)))), naira(m(sum(d.schedule.instalments.map((i) => dec(i.principalPaid).plus(i.interestPaid))))), ""],
    });
  }
  pdf.signatureBlock(["Only transactions confirmed by the Bursary are shown. Pending reports do not reduce the outstanding balance."]);
  await audit(db, actor, { action: "loan.statement_generated", entityType: "loan_account", entityId: loan.id });
  return { bytes: await pdf.finish(db, actor, { entityType: "loan_account", entityId: loan.id, loanAccountId: loan.id, subjectUserId: loan.borrowerId }), fileName: `${loan.accountNumber}-statement-${todayLagos()}.pdf` };
}
