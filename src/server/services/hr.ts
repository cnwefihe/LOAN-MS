import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanApplications, applicationGuarantors, guarantorAssessments, hrVerifications, users, loanProducts, staffProfiles, departments, applicationMessages } from "@/db/schema";
import { dec, m, formatNaira } from "@/lib/finance/money";
import { assertCan, can, type Actor } from "../actor";
import { audit } from "../audit";
import { notify } from "../notifications";
import { transition } from "../workflow";
import { DomainError, NotFoundError } from "../errors";
import { getPolicyVersion } from "./policies";
import { computeEligibilityFor, assessedWith } from "./applications";
import { guarantorExposure, LIVE_GUARANTEE_STATUSES } from "./guarantors";
import { syncRegisterFromProfile } from "./staff-records";
import { getStaffRecord, payslipDetailsConfirmed } from "./staff";

type AppStatus = (typeof loanApplications.$inferSelect)["status"];

export async function applicationQueue(db: Executor, actor: Actor, opts: { statuses?: AppStatus[]; q?: string; limit?: number } = {}) {
  const conds = [];
  if (opts.statuses?.length) conds.push(inArray(loanApplications.status, opts.statuses));
  else conds.push(sql`${loanApplications.status} <> 'draft'`);
  if (opts.q?.trim()) {
    const q = `%${opts.q.trim()}%`;
    conds.push(or(ilike(loanApplications.reference, q), ilike(users.displayName, q), ilike(users.email, q), ilike(staffProfiles.staffNumber, q)));
  }
  return db.select({
    app: loanApplications, applicantName: users.displayName, applicantEmail: users.email, productName: loanProducts.name,
    staffNumber: staffProfiles.staffNumber, department: departments.name, approverTitle: departments.approverTitle,
  }).from(loanApplications)
    .innerJoin(users, eq(users.id, loanApplications.applicantId))
    .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanApplications.applicantId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(and(...conds))
    .orderBy(desc(loanApplications.submittedAt))
    .limit(opts.limit ?? 5000);
}

export interface HrDecisionInput {
  outcome: "verified" | "returned" | "declined";
  employmentVerified: boolean;
  salaryVerified: boolean;
  staffStatusVerified: boolean;
  departmentVerified: boolean;
  /** Everyone's payslip details (name, employee code, pay grade) match the personnel record: verifying confirms them. */
  detailsVerified?: boolean;
  /** The people (applicant, guarantors) whose payslip details Human Resources ticked as matching: verifying confirms them. */
  detailsVerifiedFor?: string[];
  employmentStatus?: (typeof staffProfiles.$inferInsert)["employmentStatus"];
  employmentDate?: string | null;
  monthlyBasic?: string;
  monthlyGross?: string;
  monthlyNet?: string;
  notes: string;
  guarantorAssessments: { guaranteeId: string; outcome: "capable" | "not_capable" | "needs_review"; notes?: string }[];
}

export async function recordHrDecision(db: Executor, actor: Actor, applicationId: string, input: HrDecisionInput) {
  assertCan(actor, "hr.verify");
  if (input.notes.trim().length < 10) throw new DomainError("Record your due-diligence notes (at least 10 characters).");
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).for("update");
    if (!app) throw new NotFoundError("Application");
    if (app.status !== "pending_hr") throw new DomainError("This application is not awaiting Human Resources verification.");
    const policy = await getPolicyVersion(tx, app.policyVersionId);

    // Update the authoritative staff record with what HR has verified.
    const salaryProvided = input.monthlyBasic && input.monthlyGross && input.monthlyNet;
    if (salaryProvided && dec(input.monthlyNet!).greaterThan(input.monthlyGross!)) throw new DomainError("Net salary cannot exceed gross salary.");
    const patch: Partial<typeof staffProfiles.$inferInsert> = { updatedAt: new Date() };
    if (input.employmentStatus) patch.employmentStatus = input.employmentStatus;
    if (input.employmentDate) patch.employmentDate = input.employmentDate;
    if (input.employmentVerified) { patch.employmentVerifiedBy = actor.userId; patch.employmentVerifiedAt = new Date(); }
    if (salaryProvided && input.salaryVerified) {
      Object.assign(patch, { monthlyBasic: m(input.monthlyBasic!), monthlyGross: m(input.monthlyGross!), monthlyNet: m(input.monthlyNet!), salarySource: "hr_verified", salaryVerifiedBy: actor.userId, salaryVerifiedAt: new Date() });
    }
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, app.applicantId));
    await tx.update(staffProfiles).set(patch).where(eq(staffProfiles.userId, app.applicantId));
    if (input.employmentStatus || input.employmentDate) await syncRegisterFromProfile(tx, actor.userId, app.applicantId);
    await audit(tx, actor, { action: "staff.verified_by_hr", entityType: "staff_profile", entityId: app.applicantId, before, after: patch, summary: `During verification of ${app.reference}` });

    const elig = await computeEligibilityFor(tx, app.applicantId, policy.params, { requestedAmount: app.requestedAmount, tenorMonths: app.tenorMonths, excludeApplicationId: app.id, ...assessedWith(app) });
    // Eligibility comes from the payslip. When HR confirms the salary against payroll, the payslip's figures
    // become the verified salary on the staff record (unless HR entered the figures directly).
    if (input.salaryVerified && !salaryProvided && elig.payslip) {
      await tx.update(staffProfiles).set({ monthlyBasic: elig.payslip.basic, monthlyGross: elig.payslip.payForLending, monthlyNet: elig.payslip.netPay, salarySource: "hr_verified", salaryVerifiedBy: actor.userId, salaryVerifiedAt: new Date() }).where(eq(staffProfiles.userId, app.applicantId));
    }
    const rec = await getStaffRecord(tx, app.applicantId);

    // Guarantor assessments (one per live guarantee).
    const guarantees = await tx.select().from(applicationGuarantors).where(and(eq(applicationGuarantors.applicationId, app.id), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));
    // Assessing guarantors is its own permission; verifying an application with guarantors needs it.
    if (guarantees.length && (input.outcome === "verified" || input.guarantorAssessments.length) && !can(actor, "hr.guarantor.assess")) {
      throw new DomainError("Assessing guarantors needs the 'Assess guarantor eligibility and capacity' permission. Ask an administrator, or leave the application for a colleague who has it.");
    }
    for (const g of guarantees) {
      const a = input.guarantorAssessments.find((x) => x.guaranteeId === g.id);
      if (!a) {
        if (input.outcome === "verified") throw new DomainError("Assess every guarantor before verifying the application.");
        continue;
      }
      const exposure = await guarantorExposure(tx, g.guarantorId);
      const grec = await getStaffRecord(tx, g.guarantorId);
      await tx.insert(guarantorAssessments).values({ applicationGuarantorId: g.id, assessedBy: actor.userId, outcome: a.outcome, existingExposure: exposure.total, monthlyNetAtAssessment: grec.profile?.monthlyNet ?? null, notes: a.notes?.trim() || null });
    }

    if (input.outcome === "verified") {
      if (!(input.employmentVerified && input.salaryVerified && input.staffStatusVerified && input.departmentVerified)) throw new DomainError("All verification checks must be confirmed before forwarding for approval.");
      if (!elig.payslip) throw new DomainError("The applicant has no payslip on file. Return the application so they can upload one.");
      if (!elig.eligible) throw new DomainError(`On verified figures the application is not eligible: ${elig.reasons.join(" ")} Return or decline it instead.`);
      if (guarantees.filter((g) => g.status === "accepted").length < policy.params.requiredGuarantors) throw new DomainError("The required guarantors have not all accepted.");
      if (input.guarantorAssessments.some((a) => a.outcome !== "capable")) throw new DomainError("All guarantors must be assessed as capable to forward the application. Return it so the applicant can nominate a replacement.");
      const people = [app.applicantId, ...guarantees.filter((g) => g.status === "accepted").map((g) => g.guarantorId)];
      const details = await tx.select({ userId: staffProfiles.userId, d: staffProfiles }).from(staffProfiles).where(inArray(staffProfiles.userId, people));
      const ticked = input.detailsVerified ? people : people.filter((u) => input.detailsVerifiedFor?.includes(u));
      const blank = ticked.filter((u) => { const d = details.find((r) => r.userId === u)?.d; return !d?.staffNumber || !d.payGrade; });
      if (blank.length) throw new DomainError(`${blank.includes(app.applicantId) ? "The applicant has" : "A guarantor has"} not entered their payslip details (employee code and pay grade) on My profile.`);
      if (ticked.length) await tx.update(staffProfiles).set({ payslipDetailsConfirmedBy: actor.userId, payslipDetailsConfirmedAt: new Date() }).where(inArray(staffProfiles.userId, ticked));
      const unconfirmed = people.filter((u) => !ticked.includes(u) && !payslipDetailsConfirmed(details.find((r) => r.userId === u)?.d));
      if (unconfirmed.length) {
        throw new DomainError(`Confirm the payslip details (name, employee code and pay grade) of ${unconfirmed.includes(app.applicantId) ? "the applicant" : "each guarantor"} before verifying: tick each person under "Payslip details match the personnel record".`);
      }
    }

    await tx.insert(hrVerifications).values({
      applicationId: app.id, officerId: actor.userId, outcome: input.outcome, employmentVerified: input.employmentVerified, salaryVerified: input.salaryVerified,
      staffStatusVerified: input.staffStatusVerified, departmentVerified: input.departmentVerified, serviceMonths: rec.serviceMonths,
      verifiedMonthlyBasic: rec.profile?.monthlyBasic ?? null, verifiedMonthlyGross: rec.profile?.monthlyGross ?? null, verifiedMonthlyNet: rec.profile?.monthlyNet ?? null,
      existingObligations: m(dec(elig.monthlyDeductionCap).minus(elig.availableMonthlyCapacity)), recomputedEligibleAmount: elig.maxEligibleAmount, dueDiligenceNotes: input.notes.trim(),
    });

    const [applicant] = await tx.select().from(users).where(eq(users.id, app.applicantId));
    const vars = { reference: app.reference, applicantName: applicant.displayName, amount: formatNaira(app.requestedAmount), comment: input.notes.trim(), level: 1 };
    if (input.outcome === "verified") {
      await transition(tx, actor, app.id, "hr_verify", { comment: input.notes.trim(), patch: { currentApprovalLevel: 0, eligibleAmount: elig.maxEligibleAmount } });
      await notify(tx, { template: "application.hr_verified", userIds: [app.applicantId], link: `/applications/${app.id}`, vars });
      await notify(tx, { template: "application.pending_bursary", roles: ["BURSARY_OFFICER"], excludeUserIds: [app.applicantId, ...guarantees.map((g) => g.guarantorId)], link: `/bursary/review/${app.id}`, vars });
    } else if (input.outcome === "returned") {
      await transition(tx, actor, app.id, "hr_return", { comment: input.notes.trim() });
      await tx.insert(applicationMessages).values({ applicationId: app.id, authorId: actor.userId, kind: "correction", body: input.notes.trim() });
      await notify(tx, { template: "application.returned", userIds: [app.applicantId], link: `/applications/${app.id}`, vars });
    } else {
      await transition(tx, actor, app.id, "hr_decline", { comment: input.notes.trim() });
      await notify(tx, { template: "application.declined", userIds: [app.applicantId, ...guarantees.map((g) => g.guarantorId)], link: `/applications/${app.id}`, vars });
    }
    return elig;
  });
}

export async function staffDirectory(db: Executor, actor: Actor, q?: string) {
  assertCan(actor, "hr.staff.view");
  const conds = [eq(users.isDevFixture, users.isDevFixture)];
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    conds.push(or(ilike(users.displayName, like), ilike(users.email, like), ilike(staffProfiles.staffNumber, like))!);
  }
  return db.select({ user: users, profile: staffProfiles, department: departments.name }).from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(and(...conds)).orderBy(users.displayName);
}
