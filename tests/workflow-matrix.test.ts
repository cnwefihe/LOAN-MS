/**
 * Full workflow at three borrowing amounts, plus a decline by the HR Director. Each loan goes
 * application → guarantors → HR Administrator → Bursary Officer → Line Manager → HR Director →
 * Bursar → payout by the Accounts Payable Officer → payroll and claimed repayments confirmed by the
 * Bursary Officer → receipts → early settlement → clearance. Documents are checked in encrypted storage and in the verification register, and every
 * email is delivered through the Microsoft Graph double and inspected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { startFakeGraph, type FakeGraph } from "./support/fake-graph.mjs";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-matrix-"));
process.env.APP_BASE_URL = "https://loans.example.edu.ng";

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { createProduct, updateDraft, submitPolicy, approvePolicy, setProductActive, listPolicyVersions } from "@/server/services/policies";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { updatePayslipDetails, confirmPayslipDetails, payslipDetailsConfirmed } from "@/server/services/staff";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { storeDocument, readDocument } from "@/server/services/documents";
import {
  recordDisbursement, submitRepaymentClaim, confirmRepaymentClaim, receiptPdf, statementPdf, clearancePdf,
  proposeEarlySettlement, approvePendingTransaction, getLoanDetail,
} from "@/server/services/loans";
import { postPayrollDeductions } from "@/server/services/payroll";
import { settlementQuote } from "@/server/services/ledger";
import { verifyFile } from "@/server/services/verification";
import { processOutbox } from "@/server/email";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import { recordSamplePayslip } from "@/server/services/payslips";
import { dec, m } from "@/lib/finance/money";
import { todayLagos, addMonths } from "@/lib/finance/dates";
import { encryptString } from "@/lib/security/crypto";
import { buildDataset, reportParams, totalOf, arrearsAgeing, executiveSummary } from "@/server/services/reports";
import { datasetPdf, managementPdf, datasetCsv, workbook } from "@/server/report-render";
import { pdfText } from "./support/pdf-text";

let db: Database;
let graph: FakeGraph;
const ids: Record<string, string> = {};
const ctx = { ip: "127.0.0.1", userAgent: "vitest" };
const actor = async (id: string): Promise<Actor> => (await loadActor(db, id, ctx))!;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
let productId: string;

const CASES = [
  { key: "small", name: "Bola Ade", amount: "500000", tenor: 6, salary: ["300000", "450000", "400000"] },
  { key: "medium", name: "Chika Nwafor", amount: "1500000", tenor: 12, salary: ["600000", "900000", "750000"] },
  { key: "large", name: "Dayo Martins", amount: "3300000", tenor: 12, salary: ["1000000", "1500000", "1200000"] },
  { key: "declined", name: "Efe Okoro", amount: "2000000", tenor: 12, salary: ["700000", "1000000", "850000"] },
] as const;
type Case = (typeof CASES)[number];
const state: Record<string, { userId: string; email: string; staffNumber: string; guarantors: string[]; appId?: string; loanId?: string; instalment?: string }> = {};

/** A sample payslip: medical 10% of basic, tax 10%, pension 8%, so net pay is 92% of basic. */
async function givePayslip(userId: string, name: string, code: string, basic: string) {
  const b = Number(basic);
  const self: Actor = { userId, email: "", displayName: name, roles: [], permissions: new Set() };
  // The staff member enters their payslip details on their profile; HR confirms them at verification.
  await updatePayslipDetails(db, { ...self, permissions: new Set(["profile.edit_own"]) }, { name, staffNumber: code, payGrade: "Senior Lecturer" });
  await recordSamplePayslip(db, self, userId, samplePayslip({ name, code, grade: "Senior Lecturer", period: todayLagos().slice(0, 7), basic, medical: (b * 0.1).toFixed(2), tax: (b * 0.1).toFixed(2), pension: (b * 0.08).toFixed(2) }));
}

async function createStaff(email: string, name: string, staffNumber: string, salary: readonly string[]) {
  const [u] = await db.insert(s.users).values({ email, displayName: name, isDevFixture: true }).returning();
  const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "APPLICANT"));
  await db.insert(s.userRoles).values({ userId: u.id, roleId: role.id });
  const [dept] = await db.select().from(s.departments).where(eq(s.departments.code, "MCM")); // headed by the Line Manager fixture
  await db.insert(s.staffProfiles).values({
    userId: u.id, staffNumber, departmentId: dept.id, schoolId: dept.schoolId, designation: "Senior Lecturer", employmentStatus: "confirmed", phone: "+234 803 000 0000", residentialAddress: "Lekki, Lagos",
    employmentDate: addMonths(todayLagos(), -72), monthlyBasic: salary[0], monthlyGross: salary[1], monthlyNet: salary[2],
    salarySource: "hr_verified", salaryVerifiedAt: new Date(), bankName: "Test Bank", bankAccountNumberEnc: encryptString("0123456789"), bankAccountLast4: "6789", bankAccountName: name,
  });
  await givePayslip(u.id, name, staffNumber, salary[0]);
  return u;
}

async function createBorrower(c: Case, i: number) {
  // Staff may guarantee one loan at a time, so each borrower nominates two guarantors of their own.
  const guarantors: string[] = [];
  for (const n of [1, 2]) {
    const gEmail = `${c.key}.guarantor${n}.matrix@example.edu.ng`;
    await createStaff(gEmail, `Guarantor ${n} for ${c.name}`, `MXG-${i}${n}`, ["800000", "800000", "700000"]);
    guarantors.push(gEmail);
  }
  const email = `${c.name.toLowerCase().replace(" ", ".")}.matrix@example.edu.ng`;
  const [u] = await db.insert(s.users).values({ email, displayName: c.name, isDevFixture: true }).returning();
  const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "APPLICANT"));
  await db.insert(s.userRoles).values({ userId: u.id, roleId: role.id });
  const [dept] = await db.select().from(s.departments).where(eq(s.departments.code, "MCM")); // headed by the Line Manager fixture
  const staffNumber = `MX-${1000 + i}`;
  await db.insert(s.staffProfiles).values({
    userId: u.id, staffNumber, departmentId: dept.id, schoolId: dept.schoolId, designation: "Senior Lecturer", employmentStatus: "confirmed", phone: "+234 803 000 0000", residentialAddress: "Lekki, Lagos",
    employmentDate: addMonths(todayLagos(), -72), monthlyBasic: c.salary[0], monthlyGross: c.salary[1], monthlyNet: c.salary[2],
    salarySource: "hr_verified", salaryVerifiedAt: new Date(), bankName: "Test Bank", bankAccountNumberEnc: encryptString("0123456789"), bankAccountLast4: "6789", bankAccountName: c.name,
  });
  await givePayslip(u.id, c.name, staffNumber, c.salary[0]);
  state[c.key] = { userId: u.id, email, staffNumber, guarantors };
}

const mailTo = (email: string) => graph.captured.filter((x) => x.to === email);

beforeAll(async () => {
  graph = await startFakeGraph();
  Object.assign(process.env, {
    EMAIL_TRANSPORT: "graph", EMAIL_GRAPH_TENANT_ID: "contoso-tenant", EMAIL_GRAPH_CLIENT_ID: "test-client", EMAIL_GRAPH_CLIENT_SECRET: "test-secret",
    EMAIL_SENDER_ADDRESS: "loans@example.edu.ng", GRAPH_BASE_URL: graph.url, ENTRA_AUTHORITY_HOST: graph.url,
  });
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
  for (const [i, c] of CASES.entries()) await createBorrower(c, i);
});

afterAll(async () => {
  for (const k of ["EMAIL_TRANSPORT", "EMAIL_GRAPH_TENANT_ID", "EMAIL_GRAPH_CLIENT_ID", "EMAIL_GRAPH_CLIENT_SECRET", "EMAIL_SENDER_ADDRESS", "GRAPH_BASE_URL", "ENTRA_AUTHORITY_HOST"]) delete process.env[k];
  await graph.close();
});

describe("product", () => {
  it("is configured, approved by the administrator and opened", async () => {
    const admin = await actor(ids.admin);
    const p = await createProduct(db, admin, { code: "MATRIX", name: "Staff Development Loan" });
    productId = p.id;
    const [draft] = await listPolicyVersions(db, p.id);
    await updateDraft(db, admin, draft.id, {
      ...DEFAULT_POLICY, minTenorMonths: 6, maxTenorMonths: 12,
      requiredGuarantors: 2, maxGuarantorExposure: "20000000.00", maxGuaranteesPerGuarantor: 5,
    }, "Matrix test product");
    await submitPolicy(db, admin, draft.id);
    await approvePolicy(db, admin, draft.id);
    await setProductActive(db, admin, p.id, true);
  });
});

describe.each(CASES.map((c) => [c.key, c] as const))("%s request", (key, c) => {
  it("applicant submits with two guarantors and a payslip", async () => {
    const b = await actor(state[key].userId);
    await expect(saveDraft(db, b, { productId, requestedAmount: "9000000", tenorMonths: c.tenor, purpose: "Too much for this product", guarantorEmails: [] })
      .then((r) => { if (!r.eligibility.eligible) throw new Error(r.eligibility.reasons.join(" ")); })).rejects.toThrow(/more than the most you can borrow/);
    const draft = await saveDraft(db, b, { productId, requestedAmount: c.amount, tenorMonths: c.tenor, purpose: `Matrix test: ${key} request`, guarantorEmails: state[key].guarantors });
    expect(draft.eligibility.eligible).toBe(true);
    state[key].appId = draft.id;
    await storeDocument(db, b, { buffer: PDF, fileName: "payslip.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: b.userId, applicationId: draft.id, requirementCode: "PAYSLIP" });
    await submitApplication(db, b, draft.id, { termsAccepted: true });
    await processOutbox(200);
    expect(mailTo(state[key].email).map((x) => x.subject)).toContain(`Loan application ${(await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, draft.id)))[0].reference} submitted`);
  });

  it("both guarantors accept with electronic signatures", async () => {
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, state[key].appId!));
    expect(gs).toHaveLength(2);
    for (const g of gs) {
      const ga = await actor(g.guarantorId);
      const [u] = await db.select().from(s.users).where(eq(s.users.id, g.guarantorId));
      await respondToGuarantee(db, ga, g.id, { decision: "accept", typedName: u.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    }
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, state[key].appId!));
    expect(app.status).toBe("pending_hr");
  });

  it("HR verifies employment, salary and guarantors", async () => {
    const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, state[key].appId!), eq(s.applicationGuarantors.status, "accepted")));
    const hr = await actor(ids.hradmin);
    const verify = () => recordHrDecision(db, hr, state[key].appId!, {
      outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true,
      notes: "Verified against the personnel file and payroll.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })),
    });
    await expect(verify()).rejects.toThrow(/Confirm the payslip details/);
    for (const u of [state[key].userId, ...gs.map((g) => g.guarantorId)]) await confirmPayslipDetails(db, hr, u);
    await recordHrDecision(db, hr, state[key].appId!, {
      outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true,
      notes: "Verified against the personnel file and payroll.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })),
    });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, state[key].appId!));
    expect(app.status).toBe("pending_bursary");
    await reviewByBursary(db, await actor(ids.bursary), state[key].appId!, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
    const [cleared] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, state[key].appId!));
    expect(cleared.status).toBe("pending_approval");
  });

  it("is approved by the Line Manager, the HR Director and the Bursar in turn", async () => {
    const approvers = [ids.hod, ids.hrdirector, ids.accadmin];
    const levels = key === "declined" ? 2 : 3;
    for (let level = 1; level <= levels; level++) {
      const last = level === levels;
      const decline = key === "declined" && last;
      const r = await decideApplication(db, await actor(approvers[level - 1]), state[key].appId!, decline
        ? { decision: "declined", comments: "Declined by the HR Director: exposure too high for this applicant's grade." }
        : { decision: "approved", comments: `Approved at stage ${level}.` });
      if (!last) {
        expect(r.status).toBe("pending_approval");
        await expect(decideApplication(db, await actor(approvers[level - 1]), state[key].appId!, { decision: "approved", comments: "Same person again." })).rejects.toThrow(/Only the/);
      } else if (decline) {
        expect(r.status).toBe("declined");
      } else {
        expect(r.status).toBe("approved");
        state[key].loanId = r.loan!.id;
        state[key].instalment = r.loan!.monthlyInstalment;
      }
    }
    const approvals = await db.select().from(s.approvals).where(eq(s.approvals.applicationId, state[key].appId!));
    expect(approvals).toHaveLength(levels);
    expect(new Set(approvals.map((a) => a.approverId)).size).toBe(levels);
    await processOutbox(200);
    const subjects = mailTo(state[key].email).map((x) => x.subject);
    expect(subjects.some((x) => /declined/.test(x))).toBe(key === "declined");
    expect(subjects.some((x) => /approved/.test(x))).toBe(key !== "declined");
  });

  if (c.key === "declined") return;

  it("the Accounts Payable Officer pays it out; documents are stored and registered", async () => {
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, state[key].loanId!));
    await recordDisbursement(db, await actor(ids.accounts), loan.id, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: `FT-${key}`, amountDisbursed: loan.principal, idempotencyKey: `dsb-${key}` });
    const detail = await getLoanDetail(db, await actor(state[key].userId), loan.id);
    expect(detail.loan.status).toBe("active");
    expect(detail.schedule!.instalments).toHaveLength(c.tenor);

    // Agreements and the disbursement advice are encrypted in storage and readable by the borrower only.
    const docs = await db.select().from(s.documents).where(and(eq(s.documents.loanAccountId, loan.id), eq(s.documents.isSystemGenerated, true)));
    expect(docs.map((x) => x.category).sort()).toEqual(["guarantor_agreement", "guarantor_agreement", "loan_agreement", "statement"]);
    const advice = docs.find((x) => x.category === "statement")!;
    const { data } = await readDocument(db, await actor(state[key].userId), advice.id);
    expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    const other = CASES.find((x) => x.key !== key && x.key !== "declined")!;
    await expect(readDocument(db, await actor(state[other.key].userId), advice.id)).rejects.toThrow(/do not have access/);
    expect((await verifyFile(db, await actor(ids.accadmin), data)).matches[0]?.kind).toBe("disbursement_advice");
  });
});

describe("repayments, receipts and closure for every approved loan", () => {
  const live = CASES.filter((c) => c.key !== "declined");

  it("posts a payroll deduction file for all borrowers in one run", async () => {
    const rows = live.map((c) => ({ staffNumber: state[c.key].staffNumber, amount: state[c.key].instalment!, reference: `PAYROLL-${todayLagos().slice(0, 7)}-${state[c.key].staffNumber}`, valueDate: todayLagos() }));
    const r = await postPayrollDeductions(db, await actor(ids.payroll), rows, "matrix-test.csv");
    expect(r).toEqual({ posted: 3, duplicates: 0, errors: [] });
    const again = await postPayrollDeductions(db, await actor(ids.payroll), rows, "matrix-test.csv");
    expect(again.duplicates).toBe(3); // the same file cannot be posted twice
    for (const c of live) {
      const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, state[c.key].loanId!));
      expect(loan.totalRepaid).toBe(m(state[c.key].instalment!));
    }
  });

  it("confirms a borrower's reported deduction and issues a verifiable receipt", async () => {
    const c = live[1];
    const b = await actor(state[c.key].userId);
    const claim = await submitRepaymentClaim(db, b, state[c.key].loanId!, { amount: state[c.key].instalment!, deductionMonth: todayLagos().slice(0, 7), channel: "bank_transfer" });
    const txn = await confirmRepaymentClaim(db, await actor(ids.payroll), claim.id, { amount: state[c.key].instalment!, valueDate: todayLagos(), bankReference: `BANK-${c.key}` });
    const r = await receiptPdf(db, b, (txn as { id: string }).id);
    const v = await verifyFile(db, await actor(ids.accadmin), r.bytes);
    expect(v.matches[0]).toEqual(expect.objectContaining({ kind: "receipt", subjectName: c.name }));
    const tampered = Buffer.from(r.bytes);
    tampered[tampered.length - 20] ^= 1;
    expect((await verifyFile(db, await actor(ids.accadmin), tampered)).matches).toHaveLength(0);
    const statement = await statementPdf(db, b, state[c.key].loanId!);
    expect(statement.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("produces standard reports from the live book: registers, ageing, payroll schedule and the management report", async () => {
    const admin = await actor(ids.admin);
    const p = reportParams({});
    const disb = await buildDataset(db, admin, "disbursements", p);
    expect(disb.rows).toHaveLength(3);
    expect(totalOf(disb.rows, "disbursed")).toBe(m(live.reduce((a, c) => a.plus(dec(c.amount)), dec(0))));
    expect((await buildDataset(db, admin, "disbursements", reportParams({ from: "2020-01-01", to: "2020-12-31" }))).rows).toHaveLength(0);
    const coll = await buildDataset(db, admin, "collections", p);
    expect(coll.rows).toHaveLength(4); // three payroll deductions and one confirmed claim
    const ageing = await arrearsAgeing(db, admin);
    expect(ageing[0]).toMatchObject({ bucket: "Current (not past due)", loans: 3, share: 100 });

    // Payroll schedule for the month the large loan's fourth instalment falls due: one line per borrower, no arrears.
    const [fourth] = await db.select().from(s.scheduleInstalments).where(and(eq(s.scheduleInstalments.loanAccountId, state.large.loanId!), eq(s.scheduleInstalments.sequence, 4)));
    const accounts = await actor(ids.accounts); // Accounts Payable Officer: accounts.view without reports.export
    const sched = await buildDataset(db, accounts, "payroll_deductions", reportParams({ month: fourth.dueDate.slice(0, 7) }));
    const large = sched.rows.find((r) => r.loanId === state.large.loanId)!;
    expect(large).toMatchObject({ scheduled: m(state.large.instalment!), arrears: "0.00", total: m(state.large.instalment!) });
    expect(sched.rows.every((r) => dec(r.total as string).equals(dec(r.scheduled as string).plus(r.arrears as string)))).toBe(true);
    await expect(buildDataset(db, accounts, "audit", p)).rejects.toThrow(/not authorised|permission/i);
    expect((await buildDataset(db, admin, "audit", p)).rows.length).toBeGreaterThan(20);

    // Structured PDF: control panel, numbered sections, totals row, notes and sign-off; registered as a report.
    const pdf = await pdfText(await datasetPdf(db, admin, "collections", coll));
    for (const t of ["Collections register", "Reporting basis", "1. Summary", "2. Detail", "Total (4)", "3. Notes and definitions", "4. Review and sign-off", "Prepared by".toUpperCase(), "Pan-Atlantic University. Authorised User Only."]) expect(pdf.text, t).toContain(t);
    expect(pdf.text.split("CONFIDENTIAL").length - 1).toBe(pdf.pages + 1); // watermark on each page, plus the classification field
    const mgmt = await pdfText(await managementPdf(db, admin));
    for (const t of ["Portfolio Report", "Portfolio position", "Repayment performance", "Arrears ageing", "Loans requiring attention", "Departmental distribution", "Guarantor exposure", "Expected", "Collected"]) expect(mgmt.text, t).toContain(t);
    expect(mgmt.pages).toBeGreaterThanOrEqual(2);
    const csv = datasetCsv(disb);
    expect(csv.split("\r\n")).toHaveLength(4);
    expect(csv).toContain("Bank transfer");
    expect((await workbook(db, admin, await executiveSummary(db, admin), sched, sched.title, sched.basis)).subarray(0, 2).toString()).toBe("PK");
    const reports = await db.select().from(s.issuedDocuments).where(eq(s.issuedDocuments.kind, "report"));
    expect(reports.map((r) => r.entityId).sort()).toEqual(["collections", "management"]);
  });

  it("closes every loan (settled through the internal test route) and issues a clearance letter", async () => {
    for (const c of live) {
      const loanId = state[c.key].loanId!;
      const q = await settlementQuote(db, loanId);
      const t = await proposeEarlySettlement(db, await actor(ids.bursary), loanId, { amountReceived: q.settlementAmount, valueDate: todayLagos(), reference: `SETTLE-${c.key}` });
      await approvePendingTransaction(db, await actor(ids.accadmin), t.id);
      const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      expect(loan.status).toBe("closed");
      expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe("0.00");
      const letter = await clearancePdf(db, await actor(state[c.key].userId), loanId);
      expect((await verifyFile(db, await actor(ids.accadmin), letter.bytes)).matches[0]?.kind).toBe("clearance_letter");
    }
    const res = (await db.execute(sql`select sum(case when direction='debit' then amount else -amount end) as net from ledger_entries`)) as unknown as { rows: { net: string }[] };
    expect(dec(res.rows[0].net).isZero()).toBe(true);
  });

  it("delivered every email through Microsoft Graph, branded and marked", async () => {
    await processOutbox(500);
    const pending = await db.select().from(s.emailOutbox).where(inArray(s.emailOutbox.status, ["queued", "failed", "not_configured"]));
    expect(pending).toHaveLength(0);
    for (const c of live) {
      const subjects = mailTo(state[c.key].email).map((x) => x.subject);
      for (const re of [/submitted/, /approved/, /disbursed/, /Repayment of .* confirmed/, /closed|settled|repaid/i]) expect(subjects.some((x) => re.test(x)), `${c.key}: ${re}`).toBe(true);
    }
    for (const c of CASES) for (const g of state[c.key].guarantors) expect(mailTo(g).some((x) => /guarant/i.test(x.subject)), g).toBe(true);
    expect(mailTo("kunle.adeyemi.dev@example.edu.ng").length).toBeGreaterThan(0); // HR queue
    expect(mailTo("funmi.adebayo.dev@example.edu.ng").some((x) => /awaiting your approval/.test(x.subject))).toBe(true); // Line Manager
    expect(mailTo("halima.musa.dev@example.edu.ng").some((x) => /awaiting your approval/.test(x.subject))).toBe(true); // HR Director
    expect(mailTo("bisi.lawal.dev@example.edu.ng").length).toBeGreaterThan(0); // checker queue
    for (const mail of graph.captured) {
      expect(mail.html).toContain("Loan Management System · Pan-Atlantic University");
      expect(`${mail.subject}${mail.html}`).not.toMatch(/\u2014/);
    }
    expect(graph.stats.tokenRequests).toBe(1);
  });

  it("recorded every issued PDF in the register under its loan's single reference", async () => {
    const reg = await db.select().from(s.issuedDocuments);
    expect(reg.length).toBeGreaterThanOrEqual(3 * 4 + 3 + 1 + 1);
    expect(reg.every((r) => /^LMS-\d{6}-\d{3}$/.test(r.reference))).toBe(true);
    const loans = await db.select().from(s.loanAccounts);
    for (const d of reg.filter((r) => r.loanAccountId)) expect(d.reference).toBe(loans.find((l) => l.id === d.loanAccountId)!.accountNumber);
    const txns = await db.select().from(s.financialTransactions);
    for (const t of txns) expect(t.reference).toBe(loans.find((l) => l.id === t.loanAccountId)!.accountNumber);
    const dbErr = async (p: Promise<unknown>) => { try { await p; } catch (e) { return String((e as { cause?: Error }).cause?.message ?? (e as Error).message); } return "no error"; };
    expect(await dbErr(db.execute(sql`update issued_documents set sha256 = 'x'`))).toMatch(/append-only/);
  });
});

describe("payslip details on the profile", () => {
  it("are entered by the staff member, refused when the code is someone else's, and need HR again after a change", async () => {
    const self = { ...(await actor(state.small.userId)), permissions: new Set(["profile.edit_own"]) } as Actor;
    const profile = async () => (await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, state.small.userId)))[0];
    expect(payslipDetailsConfirmed(await profile())).toBe(true);
    await expect(updatePayslipDetails(db, self, { name: "Anyone", staffNumber: state.medium.staffNumber, payGrade: "Senior Lecturer" })).rejects.toThrow(/already recorded for another/);
    expect(await updatePayslipDetails(db, self, { name: self.displayName, staffNumber: state.small.staffNumber, payGrade: "Senior Lecturer" })).toBe(false);
    expect(await updatePayslipDetails(db, self, { name: self.displayName, staffNumber: state.small.staffNumber, payGrade: "Senior Lecturer II" })).toBe(true);
    expect(payslipDetailsConfirmed(await profile())).toBe(false);
    await expect(confirmPayslipDetails(db, self, state.small.userId)).rejects.toThrow();
    await confirmPayslipDetails(db, await actor(ids.hradmin), state.small.userId);
    expect(payslipDetailsConfirmed(await profile())).toBe(true);
  });
});
