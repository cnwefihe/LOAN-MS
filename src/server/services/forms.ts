/**
 * Printable records that replace the paper Employee Loan Application Form and Guarantor's Form.
 * Every section is filled from the system: entries, verifications, reviews and electronic signatures.
 */
import { desc, eq } from "drizzle-orm";
import { designationOf } from "@/lib/designation";
import type { Executor } from "@/db";
import { bursaryReviews, hrVerifications, users } from "@/db/schema";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { formatNaira } from "@/lib/finance/money";
import { addMonths, firstDueDate, formatDate, todayLagos } from "@/lib/finance/dates";
import { humanise } from "@/lib/text";
import { canSeePay, type Actor } from "../actor";
import { audit } from "../audit";
import { PdfBuilder } from "../pdf";
import { ForbiddenError } from "../errors";
import { getApplicationDetail } from "./applications";
import { getActiveTerms } from "./policies";
import { getStaffRecord } from "./staff";
import { approvalStageName, loadWording } from "../wording";
import { departmentHeadOf } from "./staff";
import { monthsText } from "@/lib/finance/dates";

const N = (v: string | null | undefined) => formatNaira(v);
const D = (v: string | Date | null | undefined) => (v ? formatDate(v) : "Not yet");

async function load(db: Executor, actor: Actor, applicationId: string) {
  const d = await getApplicationDetail(db, actor, applicationId);
  // The applicant and the staff who process loans may print these records; guarantors see their own request on screen.
  if (!d.access.isApplicant && !d.access.isStaff) throw new ForbiddenError();
  const bursary = await db.select({ r: bursaryReviews, reviewer: users.displayName }).from(bursaryReviews).innerJoin(users, eq(users.id, bursaryReviews.reviewerId))
    .where(eq(bursaryReviews.applicationId, d.app.id)).orderBy(desc(bursaryReviews.createdAt));
  // HR's verification is part of the record the applicant signs off on, so it is printed for them too.
  const hr = await db.select({ v: hrVerifications, officerName: users.displayName }).from(hrVerifications).innerJoin(users, eq(users.id, hrVerifications.officerId))
    .where(eq(hrVerifications.applicationId, d.app.id)).orderBy(desc(hrVerifications.createdAt));
  return { d, bursary, hr };
}

/** Repayment commencement and expected liquidation dates: actual once paid out, otherwise estimated. */
function repaymentDates(d: Awaited<ReturnType<typeof getApplicationDetail>>) {
  if (d.loan?.firstDueDate) return { start: formatDate(d.loan.firstDueDate), end: formatDate(d.loan.maturityDate), basis: "as scheduled" };
  const p = d.policy.params;
  const period = p.repaymentFrequency === "quarterly" ? 3 : p.repaymentFrequency === "bi_monthly" ? 2 : 1;
  const first = firstDueDate(todayLagos(), p.repaymentDayOfMonth, p.gracePeriodMonths);
  const tenor = d.loan?.tenorMonths ?? d.app.tenorMonths;
  return { start: formatDate(first), end: formatDate(addMonths(first, tenor - period)), basis: "estimated, if paid out this month" };
}

export async function applicationFormPdf(db: Executor, actor: Actor, applicationId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const { d, bursary, hr: hrRows } = await load(db, actor, applicationId);
  const { app, applicant, loan } = d;
  const p = applicant.profile;
  const quote = (app.quote as unknown as EligibilityResult | null)?.quote;
  const dates = repaymentDates(d);
  const hr = hrRows[0];
  const br = bursary[0];
  const w = await loadWording(db);
  const pdf = await PdfBuilder.create(db, { kind: "application_form", title: "Employee Loan Application Form", parent: app.reference, numbered: true, subtitle: `Reference ${app.reference} | ${humanise(app.status)}` });

  pdf.heading("Applicant information");
  pdf.keyValues([
    ["Name", applicant.user.displayName], ["Staff number", p?.staffNumber ?? "Not recorded"], ["Department", applicant.department?.name ?? "Not recorded"],
    ["Designation", designationOf(p) ?? "Not recorded"], ["Phone number", p?.phone ?? "Not given"], ["Email address", applicant.user.email],
    ["Residential address", p?.residentialAddress ?? "Not given"], ["Purpose", app.purpose],
  ]);

  pdf.heading("Loan request and repayment terms");
  pdf.keyValues([
    ["Loan product", d.product.name], ["Loan amount requested", N(app.requestedAmount)], ["Loan amount approved", loan ? N(loan.principal) : "Not yet approved"],
    ["Repayment terms", quote ? `${N(loan?.monthlyInstalment ?? quote.monthlyInstalment)} a month for ${monthsText(loan?.tenorMonths ?? app.tenorMonths)}, by salary deduction` : `${monthsText(app.tenorMonths)}`],
    ["Interest", quote ? `${N(quote.totalInterest)} (${d.policy.params.annualInterestRate}% a year, ${humanise(d.policy.params.interestMethod).toLowerCase()})` : "N/A"],
    ["Total repayable", N(loan?.totalRepayable ?? quote?.totalRepayable)],
    ["Repayment commencement date", `${dates.start} (${dates.basis})`], ["Expected liquidation date", `${dates.end} (${dates.basis})`],
    ["Submitted", D(app.submittedAt)],
  ]);

  pdf.heading(w.stage.hr);
  pdf.keyValues(hr ? [
    ["Loan status of employee", `${humanise(p?.employmentStatus ?? "not recorded")}, ${hr.v.serviceMonths ?? 0} months' service`],
    ["Verified monthly gross / net", canSeePay(actor) || d.access.isApplicant ? `${N(hr.v.verifiedMonthlyGross)} / ${N(hr.v.verifiedMonthlyNet)}` : "Seen by Human Resources and the Bursary only"],
    ["Outcome", humanise(hr.v.outcome)], ["Verified by", hr.officerName], ["Date", formatDate(hr.v.createdAt)], ["Notes", hr.v.dueDiligenceNotes],
  ] : [["Status", `Awaiting ${w.stage.hr.toLowerCase()}`]]);

  pdf.heading("Bursary information");
  pdf.keyValues(br ? [
    ["Date last loan taken", br.r.lastLoanDate ? formatDate(br.r.lastLoanDate) : "No previous loan"],
    ["Date fully repaid", br.r.lastLoanRepaidDate ? formatDate(br.r.lastLoanRepaidDate) : br.r.lastLoanDate ? "Not yet repaid" : "N/A"],
    [`Deductions are <= ${d.policy.params.maxDeductionPercent}% of net pay after this loan`, `${br.r.takeHomeTestPassed ? "Confirmed" : "Not met"}: ${N(br.r.takeHomeAfter)} is ${br.r.takeHomePercent}% of net pay ${N(br.r.monthlyNet)}`],
    ["Fund availability", br.r.fundsAvailable ? `Confirmed by the ${w.role.BURSARY_OFFICER.name}` : "Not confirmed"],
    ["Reviewed by", br.reviewer], ["Date", formatDate(br.r.createdAt)], ["Comments", br.r.comments],
  ] : [["Status", `Awaiting ${w.stage.bursary.toLowerCase()}`]]);

  pdf.heading("Approvals");
  pdf.note("Each decision was recorded electronically by the named, signed-in officer. The full audit trail is held in the Loan Management System.");
  const rows: string[][] = [];
  if (hr) rows.push([w.stage.hr, humanise(hr.v.outcome), hr.officerName, formatDate(hr.v.createdAt)]);
  for (const b of [...bursary].reverse()) rows.push([`${w.role.BURSARY_OFFICER.name} (${w.stage.bursary.toLowerCase()})`, b.r.decision === "cleared" ? "Approved" : humanise(b.r.decision), b.reviewer, formatDate(b.r.createdAt)]);
  const title = (await departmentHeadOf(db, app.applicantId))?.approverTitle;
  for (const a of d.approvals) rows.push([approvalStageName(w, a.a.level, title), a.a.decision === "approved" ? "Approved" : humanise(a.a.decision), a.approverName, formatDate(a.a.createdAt)]);
  pdf.table(["Stage", "Decision", "Name", "Date"], rows);

  await audit(db, actor, { action: "application.form_generated", entityType: "loan_application", entityId: app.id, summary: app.reference });
  return { bytes: await pdf.finish(db, actor, { entityType: "loan_application", entityId: app.id, loanAccountId: loan?.id ?? null, subjectUserId: app.applicantId }), fileName: `${app.reference}-application-form.pdf` };
}

export async function guarantorFormPdf(db: Executor, actor: Actor, applicationId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const { d, hr: hrRows } = await load(db, actor, applicationId);
  const { app, applicant } = d;
  const p = applicant.profile;
  const terms = await getActiveTerms(db, "guarantor_agreement");
  const hr = hrRows[0];
  const w = await loadWording(db);
  const accepted = d.guarantors.filter((g) => ["accepted", "pending", "clarification_requested"].includes(g.g.status));
  const pdf = await PdfBuilder.create(db, { kind: "guarantor_form", title: "Guarantor's Form (Strictly Confidential)", parent: app.reference, subtitle: `Reference ${app.reference}` });

  pdf.heading("Section A: Applicant's details");
  pdf.keyValues([
    ["Full name of applicant", applicant.user.displayName], ["Loan amount applied for", N(app.requestedAmount)], ["Department", applicant.department?.name ?? "Not recorded"],
    ["Phone number", p?.phone ?? "Not given"], ["Email address", applicant.user.email], ["Residential address", p?.residentialAddress ?? "Not given"],
  ]);

  const ordinal = ["First", "Second"];
  for (const [i, g] of accepted.slice(0, 2).entries()) {
    const sec = String.fromCharCode(66 + i * 2); // B and D for details, C and E for declarations
    const grec = await getStaffRecord(db, g.user.id);
    pdf.heading(`Section ${sec}: ${ordinal[i]} guarantor's details`);
    pdf.keyValues([
      ["Full name of guarantor", g.user.displayName], ["Department/unit", grec.department?.name ?? "Not recorded"], ["Email address", g.user.email], ["Relationship with applicant", g.g.relationship ?? "Not given"],
      ["Phone number(s)", g.g.guarantorPhone ?? "Not given"], ["Amount guaranteed", N(g.g.guaranteedAmount)], ["Status", humanise(g.g.status)],
    ]);
    pdf.heading(`Section ${String.fromCharCode(sec.charCodeAt(0) + 1)}: ${ordinal[i]} guarantor's declaration`);
    pdf.text(declaration(terms?.body));
    pdf.keyValues(g.g.status === "accepted" ? [
      ["Signature", `Signed electronically as "${g.g.acknowledgedName}"`],
      ["Date", formatDate(g.g.respondedAt)], ["Record fingerprint", (g.g.acknowledgementHash ?? "").slice(0, 32).replace(/(.{8})/g, "$1 ").trim()],
    ] : [["Signature", "Not yet signed"]]);
  }

  pdf.heading("Section F: For official use only");
  pdf.keyValues(hr ? [["Received by", `${hr.officerName}, ${w.stage.hr}`], ["Date", formatDate(hr.v.createdAt)], ["Signature", "Recorded electronically on Human Resources verification"]] : [["Received by", "Awaiting Human Resources verification"]]);

  await audit(db, actor, { action: "application.guarantor_form_generated", entityType: "loan_application", entityId: app.id, summary: app.reference });
  return { bytes: await pdf.finish(db, actor, { entityType: "loan_application", entityId: app.id, loanAccountId: d.loan?.id ?? null, subjectUserId: app.applicantId }), fileName: `${app.reference}-guarantor-form.pdf` };
}

/** The declaration paragraph of the published guarantor agreement (placeholder lines removed). */
function declaration(body: string | undefined): string {
  const para = (body ?? "").split(/\n\s*\n/).map((x) => x.trim()).find((x) => /^I agree to serve as guarantor/i.test(x));
  return para ?? "I agree to serve as guarantor for this loan application and acknowledge that I will be held financially responsible if the borrower fails to meet his or her repayment obligations. The information I have provided is accurate, and I permit the University to contact me directly should the applicant default.";
}
