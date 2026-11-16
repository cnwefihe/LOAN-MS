"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanAccounts } from "@/db/schema";
import { runAction, str, money, int, bool, file, dateStr } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { assertCan } from "@/server/actor";
import { DomainError } from "@/server/errors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary, type BursaryDecision } from "@/server/services/bursary";
import { hrUpdateStaffRecord, setStaffConfirmation, confirmPayslipDetails } from "@/server/services/staff";
import { validateUpload, storeDocument } from "@/server/services/documents";
import { EMPLOYMENT_STATUSES } from "@/lib/finance/policy";
import { payrollProvider } from "@/server/integrations/payroll";
import { importSalaryFromPayroll } from "@/server/services/payroll";

type Prev = ActionResult | null;

function employmentStatus(fd: FormData) {
  const v = str(fd, "employmentStatus");
  if (!v) return undefined;
  if (!(EMPLOYMENT_STATUSES as readonly string[]).includes(v)) throw new DomainError("Invalid employment status.");
  return v as (typeof EMPLOYMENT_STATUSES)[number];
}

export async function hrDecisionAction(applicationId: string, guaranteeIds: string[], _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const outcome = str(fd, "outcome") as "verified" | "returned" | "declined";
    if (!["verified", "returned", "declined"].includes(outcome)) throw new DomainError("Choose an outcome.");
    // Eligibility is worked out from the payslip; confirming the salary records the payslip's figures.
    await recordHrDecision(await getDb(), actor, applicationId, {
      outcome,
      employmentVerified: bool(fd, "employmentVerified"), salaryVerified: bool(fd, "salaryVerified"),
      staffStatusVerified: bool(fd, "staffStatusVerified"), departmentVerified: bool(fd, "departmentVerified"), detailsVerifiedFor: fd.getAll("detailsVerified").map(String),
      employmentStatus: employmentStatus(fd), employmentDate: str(fd, "employmentDate") || null,
      notes: str(fd, "notes"),
      guarantorAssessments: guaranteeIds.filter((id) => str(fd, `g_${id}`)).map((id) => ({ guaranteeId: id, outcome: str(fd, `g_${id}`) as "capable", notes: str(fd, `gn_${id}`) })),
    });
    return { message: "Human Resources decision recorded.", redirectTo: `/hr/applications/${applicationId}` };
  }, { revalidate: ["/hr"] });
}

export async function hrUploadAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    assertCan(actor, "hr.verify");
    const db = await getDb();
    const f = file(fd, "file");
    if (!f) throw new DomainError("Choose a file to upload.");
    const v = await validateUpload(db, f);
    await db.transaction((tx) => storeDocument(tx, actor, { buffer: v.buffer, fileName: v.fileName, mimeType: v.mime, category: "hr_verification", title: str(fd, "title") || "Human Resources verification document", applicationId }));
    return "Verification document uploaded.";
  }, { revalidate: [`/hr/applications/${applicationId}`], limit: 20 });
}

const STAFF_UPLOADS = {
  loan: { permission: "accounts.view", categories: ["restructuring", "repayment_evidence", "disbursement_evidence", "statement"] },
  approval: { permission: "approval.decide", categories: ["approval"] },
} as const;

/** Staff uploads attached to a loan (Accounts) or an application (approver); each scope only allows its own categories. */
export async function uploadStaffDocumentAction(scope: keyof typeof STAFF_UPLOADS, id: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    // Bound arguments come back from the client, so validate them like any other input.
    if (!Object.hasOwn(STAFF_UPLOADS, scope)) throw new DomainError("Unknown upload scope.");
    const rule = STAFF_UPLOADS[scope];
    assertCan(actor, rule.permission);
    const category = (str(fd, "category") || rule.categories[0]) as (typeof rule.categories)[number];
    if (!(rule.categories as readonly string[]).includes(category)) throw new DomainError("That document type is not allowed here.");
    const db = await getDb();
    const f = file(fd, "file");
    if (!f) throw new DomainError("Choose a file to upload.");
    const v = await validateUpload(db, f);
    let applicationId: string | null = null;
    let loanAccountId: string | null = null;
    if (scope === "loan") {
      const [loan] = await db.select({ app: loanAccounts.applicationId, borrower: loanAccounts.borrowerId }).from(loanAccounts).where(eq(loanAccounts.id, id));
      if (!loan) throw new DomainError("Loan not found.");
      if (loan.borrower === actor.userId) throw new DomainError("You cannot attach documents to your own loan.");
      loanAccountId = id;
      applicationId = loan.app;
    } else applicationId = id;
    await db.transaction((tx) => storeDocument(tx, actor, { buffer: v.buffer, fileName: v.fileName, mimeType: v.mime, category, title: str(fd, "title") || v.fileName, applicationId, loanAccountId }));
    return "Document uploaded.";
  }, { revalidate: ["/accounts", "/approvals"], limit: 20 });
}

export async function salaryFromPayrollAction(userId: string, _: Prev) {
  return runAction(async (actor) => {
    const provider = payrollProvider();
    if (!provider) throw new DomainError("The payroll API is not configured. Enter the verified salary manually.");
    const s = await importSalaryFromPayroll(await getDb(), actor, provider, userId);
    return `Salary updated from payroll (as of ${s.asOf || "latest run"}).`;
  }, { revalidate: ["/hr"] });
}

export async function staffRecordAction(userId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    // Kept for the record only; eligibility is worked out from the payslip.
    // An emptied box clears the figure; a figure is checked as money.
    const basic = str(fd, "monthlyBasic") !== "" ? money(fd, "monthlyBasic", "basic salary") : "";
    await hrUpdateStaffRecord(await getDb(), actor, userId, {
      staffNumber: str(fd, "staffNumber") || null, departmentId: str(fd, "departmentId") || null, schoolId: str(fd, "schoolId") || null,
      categoryId: str(fd, "categoryId") || null, ...(fd.has("designation") ? { designation: str(fd, "designation") || null } : {}), payGrade: str(fd, "payGrade") || null, payslipName: str(fd, "payslipName") || null, employmentStatus: employmentStatus(fd),
      employmentDate: str(fd, "employmentDate") ? dateStr(fd, "employmentDate", "employment date") : null,
      ...(fd.has("monthlyBasic") ? { monthlyBasic: basic } : {}),
    }, str(fd, "note") || "Record updated by Human Resources");
    return "Staff record updated.";
  }, { revalidate: ["/hr/staff"] });
}

export async function staffConfirmationAction(userId: string, confirmed: boolean, _: Prev, __: FormData) {
  return runAction(async (actor) => {
    await setStaffConfirmation(await getDb(), actor, userId, confirmed);
    return confirmed ? "Marked as confirmed staff. They can now apply for a loan." : "Marked as not confirmed. They cannot apply for a loan until confirmed.";
  }, { revalidate: ["/hr/staff"] });
}

export async function bursaryDecisionAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const decision = str(fd, "decision") as BursaryDecision;
    if (!["cleared", "declined", "returned", "refer_hr"].includes(decision)) throw new DomainError("Choose a decision.");
    await reviewByBursary(await getDb(), actor, applicationId, {
      decision, fundsAvailable: bool(fd, "fundsAvailable"), comments: str(fd, "comments"),
      lastLoanDate: str(fd, "lastLoanDate") || null, lastLoanRepaidDate: str(fd, "lastLoanRepaidDate") || null,
    });
    return { message: decision === "cleared" ? "Affirmed and sent to the Line Manager." : "Decision recorded.", redirectTo: `/bursary/review/${applicationId}` };
  }, { revalidate: ["/bursary/review", "/approvals"] });
}

export async function approvalDecisionAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const decision = str(fd, "decision") as "approved" | "declined" | "returned" | "refer_hr";
    if (!["approved", "declined", "returned", "refer_hr"].includes(decision)) throw new DomainError("Choose a decision.");
    // Only the Bursar's form offers an adjusted amount and duration.
    const adjusted = decision === "approved" && fd.has("approvedAmount");
    const r = await decideApplication(await getDb(), actor, applicationId, {
      decision,
      approvedAmount: adjusted ? money(fd, "approvedAmount", "the approved amount") : undefined,
      approvedTenorMonths: adjusted ? int(fd, "approvedTenorMonths", "Approved tenor") : undefined,
      comments: str(fd, "comments"),
    });
    return { message: r.loan ? `Approved. Loan account ${r.loan.accountNumber} opened for the Accounts Payable Officer to pay out.` : r.status === "pending_approval" ? "Approved and sent to the next approver." : "Decision recorded.", redirectTo: `/approvals/${applicationId}` };
  }, { revalidate: ["/approvals"] });
}

export async function confirmPayslipDetailsAction(userId: string, back: string, _: Prev) {
  return runAction(async (actor) => {
    await confirmPayslipDetails(await getDb(), actor, userId);
    return "Payslip details confirmed.";
  }, { revalidate: [back, `/hr/staff/${userId}`] });
}
