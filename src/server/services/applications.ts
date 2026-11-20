import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  loanApplications, applicationGuarantors, applicationMessages, workflowTransitions, users, loanProducts, documents, documentRequirements,
  hrVerifications, approvals, guarantorAssessments, loanAccounts, staffProfiles, departments,
} from "@/db/schema";
import type { EligibilityResult, SalaryFigures } from "@/lib/finance/calculator";
import { assessForStaff, type StaffContext, type StaffEligibility } from "@/lib/finance/staff-eligibility";
import { dec, m, round2, formatNaira } from "@/lib/finance/money";
import { serviceLength, todayLagos } from "@/lib/finance/dates";
import { ADVANCE_TYPES, type AdvanceType, type PolicyParameters } from "@/lib/finance/policy";
import { assertCan, canAny, type Actor } from "../actor";
import { audit } from "../audit";
import { notify } from "../notifications";
import { applicationReference } from "../references";
import { transition } from "../workflow";
import { applicantSchool } from "./funds";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import { getActivePolicy, getActiveTerms, getPolicyVersion } from "./policies";
import { getStaffRecord, getObligations, departmentHeadOf } from "./staff";
import { findOrCreateStaffByEmail, grantRole } from "./identity";
import { guarantorExposure, LIVE_GUARANTEE_STATUSES } from "./guarantors";
import { assertOnGuarantorList, guarantorEmailsFor, guarantorsByEmail } from "./guarantor-pool";
import { getSettings } from "../settings";
import { attachPayslip, getPayslip, latestPayslip } from "./payslips";

export type SalarySnapshot = SalaryFigures & { source: string };

/** Reasons that come from the Human Resources record (length of service, employment status), not from pay. */
const RECORD_REASON = /of service is required|not available to confirmed members of staff|not show you as confirmed|not on record yet/;

/** Everything about a staff member that eligibility depends on (also sent to the live calculator). */
export async function staffContext(db: Executor, userId: string, opts: { excludeApplicationId?: string; payslipId?: string | null; checkRecord?: boolean } = {}): Promise<StaffContext & { payslipId: string | null }> {
  const rec = await getStaffRecord(db, userId);
  // The payslip the application was assessed on, or else the latest one uploaded.
  const slip = opts.payslipId ? await getPayslip(db, opts.payslipId) : await latestPayslip(db, userId);
  const obligations = await getObligations(db, userId, opts.excludeApplicationId);
  const rules = await getSettings(db, ["lending.oneLoanAtATime", "lending.countGuarantees"]);
  // A guarantor could be asked to repay the loans they guarantee, so that monthly amount uses up deduction headroom too.
  const guaranteeCommitment = rules["lending.countGuarantees"] ? (await guarantorExposure(db, userId)).monthlyCommitment : "0.00";
  return {
    payslip: slip?.data ?? null, payslipId: slip?.id ?? null,
    serviceMonths: rec.serviceMonths, employmentStatus: rec.profile?.employmentStatus ?? null, guaranteeCommitment,
    openCount: obligations.liveLoanCount + obligations.inFlightApplications, oneLoanAtATime: rules["lending.oneLoanAtATime"],
    checkRecord: opts.checkRecord ?? true,
    recordKnown: !!rec.profile?.employmentDate && !!rec.profile?.employmentStatus,
  };
}

export async function computeEligibilityFor(
  db: Executor, userId: string, policy: PolicyParameters,
  opts: { requestedAmount?: string; tenorMonths?: number; excludeApplicationId?: string; payslipId?: string | null; advanceType?: AdvanceType | null; checkRecord?: boolean },
): Promise<StaffEligibility & { payslipId: string | null }> {
  const ctx = await staffContext(db, userId, opts);
  const r = assessForStaff(policy, ctx, { requestedAmount: opts.requestedAmount, tenorMonths: opts.tenorMonths, asOf: todayLagos(), advanceType: opts.advanceType });
  return { ...r, payslipId: ctx.payslipId };
}

/** What an application was assessed with besides the amount: its payslip, and for an advance its type. */
export function assessedWith(app: { payslipId: string | null; advanceType: AdvanceType | null }) {
  return { payslipId: app.payslipId, advanceType: app.advanceType };
}

export async function quoteForApplicant(db: Executor, actor: Actor, input: { productId: string; requestedAmount?: string; tenorMonths?: number }) {
  assertCan(actor, "application.create");
  const policy = await getActivePolicy(db, input.productId);
  if (!policy) throw new DomainError("This loan product is not currently open for applications.");
  return computeEligibilityFor(db, actor.userId, policy.params, { ...input, checkRecord: false });
}

/* ───────────────────────── Drafts ───────────────────────── */

export interface DraftInput {
  applicationId?: string;
  productId: string;
  requestedAmount: string;
  tenorMonths: number;
  purpose: string;
  guarantorEmails: string[];
  /** Guarantors chosen by name from the list of eligible guarantors; used instead of guarantorEmails when given. */
  guarantorIds?: string[];
  /** Applicant's contact details from the form; saved to the staff record. */
  contact?: { phone: string; residentialAddress: string } | null;
  /** For an advance product: the payment it is against. */
  advanceType?: string | null;
  /** The applicant's department; its Line Manager approves the application. */
  departmentId?: string | null;
}

export async function saveDraft(db: Executor, actor: Actor, input: DraftInput) {
  assertCan(actor, "application.create");
  if (input.purpose.trim().length < 10) throw new DomainError("Please describe the purpose of the loan (at least 10 characters).");
  if (dec(input.requestedAmount).lessThanOrEqualTo(0)) throw new DomainError("Enter the amount you wish to borrow.");
  const ids = (input.guarantorIds ?? []).filter(Boolean);
  if (new Set(ids).size < ids.length) throw new DomainError("Choose two different guarantors.");
  const chosen = input.guarantorIds ? await guarantorEmailsFor(db, ids) : input.guarantorEmails;
  const emails = [...new Set(chosen.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.includes(actor.email.toLowerCase())) throw new DomainError("You cannot nominate yourself as a guarantor.");
  if (emails.length > 2) throw new DomainError("Nominate two guarantors only.");

  return db.transaction(async (tx) => {
    const policy = await getActivePolicy(tx, input.productId);
    if (!policy) throw new DomainError("This product is not currently open for applications.");
    // An advance is recovered in one deduction and needs no guarantors.
    const isAdvance = policy.params.productType === "advance";
    const advanceType = advanceTypeFor(policy.params, input.advanceType);
    const tenorMonths = isAdvance ? 1 : input.tenorMonths;
    // An advance, or a loan that needs no guarantors (such as the Bereavement Loan), keeps none.
    const nominated = isAdvance || policy.params.requiredGuarantors === 0 ? [] : emails;
    // Assessed on the latest payslip uploaded.
    const elig = await computeEligibilityFor(tx, actor.userId, policy.params, {
      requestedAmount: input.requestedAmount, tenorMonths, excludeApplicationId: input.applicationId, advanceType, checkRecord: false,
    });
    // Length of service and employment status (or no record of them) stop the application at once: it never reaches guarantors.
    const onRecord = elig.reasons.filter((r) => RECORD_REASON.test(r));
    if (onRecord.length) throw new DomainError(`You cannot apply for this loan yet. ${onRecord.join(" ")}`);
    if (!elig.payslipId) throw new DomainError("Upload your latest payslip first.");
    const values = {
      productId: input.productId, policyVersionId: policy.id, requestedAmount: m(input.requestedAmount), tenorMonths,
      purpose: input.purpose.trim(), salarySnapshot: { ...elig.salary, source: "payslip" }, quote: elig as never,
      eligibleAmount: elig.maxEligibleAmount, nominatedGuarantors: nominated, updatedAt: new Date(),
      payslipId: elig.payslipId, advanceType,
    };
    if (input.departmentId) {
      const [dept] = await tx.select().from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.isActive, true)));
      if (!dept) throw new DomainError("Choose your department.");
      await tx.update(staffProfiles).set({ departmentId: dept.id, schoolId: dept.schoolId, updatedAt: new Date() }).where(eq(staffProfiles.userId, actor.userId));
    }
    if (input.contact) {
      const phone = input.contact.phone.trim();
      if (phone && !/^[+\d][\d\s-]{6,20}$/.test(phone)) throw new DomainError("Enter a valid phone number.");
      await tx.update(staffProfiles).set({ phone: phone || null, residentialAddress: input.contact.residentialAddress.trim() || null, updatedAt: new Date() }).where(eq(staffProfiles.userId, actor.userId));
    }
    // The school of the department chosen: its fund pool pays for the loan.
    Object.assign(values, { schoolId: await applicantSchool(tx, actor.userId) });
    if (input.applicationId) {
      const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, input.applicationId)).for("update");
      if (!app || app.applicantId !== actor.userId) throw new NotFoundError("Application");
      if (app.status !== "draft" && app.status !== "returned") throw new DomainError("Only draft or returned applications can be edited.");
      await tx.update(loanApplications).set(values).where(eq(loanApplications.id, app.id));
      await attachPayslip(tx, actor, app.id, elig.payslipId);
      await audit(tx, actor, { action: "application.draft_saved", entityType: "loan_application", entityId: app.id, summary: app.reference });
      return { id: app.id, reference: app.reference, eligibility: elig };
    }
    const reference = await applicationReference(tx);
    const [created] = await tx.insert(loanApplications).values({ ...values, reference, applicantId: actor.userId, status: "draft" }).returning();
    await attachPayslip(tx, actor, created.id, elig.payslipId);
    await tx.insert(workflowTransitions).values({ applicationId: created.id, action: "create", fromStatus: null, toStatus: "draft", actorId: actor.userId, actorRole: "APPLICANT" });
    await audit(tx, actor, { action: "application.created", entityType: "loan_application", entityId: created.id, summary: reference });
    return { id: created.id, reference, eligibility: elig };
  });
}

/** An advance must say what it is against; a loan never carries one. */
function advanceTypeFor(p: PolicyParameters, raw?: string | null): AdvanceType | null {
  if (p.productType !== "advance") return null;
  if (!raw || !(raw in ADVANCE_TYPES)) throw new DomainError("Choose whether the advance is against your salary or your leave allowance.");
  return raw as AdvanceType;
}

/* ───────────────────────── Submission ───────────────────────── */

export async function requiredDocumentsFor(db: Executor, productId: string, params: PolicyParameters) {
  const reqs = await db.select().from(documentRequirements).where(and(
    eq(documentRequirements.isActive, true), eq(documentRequirements.appliesTo, "applicant"),
    sql`(${documentRequirements.productId} = ${productId} or ${documentRequirements.productId} is null)`,
  ));
  return reqs.filter((r) => r.isRequired || params.requiredDocumentCodes.includes(r.code));
}

export async function submitApplication(db: Executor, actor: Actor, applicationId: string, opts: { termsAccepted: boolean }) {
  assertCan(actor, "application.create");
  if (!opts.termsAccepted) throw new DomainError("You must accept the loan terms and conditions to submit.");

  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).for("update");
    if (!app || app.applicantId !== actor.userId) throw new NotFoundError("Application");
    if (app.status !== "draft" && app.status !== "returned") throw new DomainError("This application has already been submitted.");

    // Always price against the currently active policy at submission time.
    const policy = await getActivePolicy(tx, app.productId);
    if (!policy) throw new DomainError("This loan product is no longer open for applications.");
    const p = policy.params;
    const elig = await computeEligibilityFor(tx, actor.userId, p, {
      requestedAmount: app.requestedAmount, tenorMonths: app.tenorMonths, excludeApplicationId: app.id, ...assessedWith(app), checkRecord: false,
    });
    if (!elig.eligible) throw new DomainError(`This application is not eligible: ${elig.reasons.join(" ")}`);
    if (!elig.quote) throw new DomainError("Could not compute a repayment quote.");
    const [contact] = await tx.select({ phone: staffProfiles.phone, address: staffProfiles.residentialAddress }).from(staffProfiles).where(eq(staffProfiles.userId, actor.userId));
    if (!contact?.phone || !contact.address) throw new DomainError("Add your phone number and residential address to the application before submitting.");

    // Required documents
    const required = await requiredDocumentsFor(tx, app.productId, p);
    const uploaded = new Set((await tx.select({ code: documents.requirementCode }).from(documents).where(eq(documents.applicationId, app.id))).map((d) => d.code));
    const missing = required.filter((r) => !uploaded.has(r.code));
    if (missing.length) throw new DomainError(`Please upload: ${missing.map((r) => r.label).join(", ")}.`);

    // Guarantors
    const emails = p.requiredGuarantors > 0 ? app.nominatedGuarantors ?? [] : [];
    if (emails.length < p.requiredGuarantors) throw new DomainError(`This loan needs ${p.requiredGuarantors === 2 ? "two guarantors" : "one guarantor"}; you have chosen ${emails.length}. Edit the application to choose them.`);
    await assertOnGuarantorList(tx, emails);
    const listed = await guarantorsByEmail(tx, emails);
    const share = p.requiredGuarantors > 0 ? round2(dec(elig.quote.totalRepayable).div(Math.max(emails.length, 1))) : null;

    const terms = await getActiveTerms(tx, "loan_terms");
    if (!terms) throw new DomainError("Loan terms and conditions have not been published. Contact the Bursary.");

    await tx.update(loanApplications).set({
      policyVersionId: policy.id, quote: elig as never, eligibleAmount: elig.maxEligibleAmount,
      salarySnapshot: { ...elig.salary, source: "payslip" } as never,
      termsDocumentId: terms.id, termsAcceptedAt: new Date(), submittedAt: new Date(), updatedAt: new Date(),
    }).where(eq(loanApplications.id, app.id));

    const live = await tx.select({ g: applicationGuarantors, email: users.email }).from(applicationGuarantors)
      .innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
      .where(and(eq(applicationGuarantors.applicationId, app.id), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));

    // Retire guarantees no longer nominated or whose obligation changed (they must re-accept the new figures).
    for (const row of live) {
      const stillNominated = emails.includes(row.email.toLowerCase());
      if (!stillNominated || (share && !dec(row.g.guaranteedAmount).equals(share))) {
        await tx.update(applicationGuarantors).set({ status: "replaced" }).where(eq(applicationGuarantors.id, row.g.id));
      }
    }
    const kept = new Set(live.filter((r) => emails.includes(r.email.toLowerCase()) && share && dec(r.g.guaranteedAmount).equals(share)).map((r) => r.email.toLowerCase()));

    const applicant = await getStaffRecord(tx, actor.userId);
    const guaranteeLimit = (await getSettings(tx, ["lending.oneGuaranteeAtATime"]))["lending.oneGuaranteeAtATime"] ? 1 : p.maxGuaranteesPerGuarantor;
    for (const email of emails) {
      if (kept.has(email)) continue;
      const guarantor = await findOrCreateStaffByEmail(tx, email, actor, listed.get(email)?.name);
      if (guarantor.id === actor.userId) throw new DomainError("You cannot guarantee your own loan.");
      if (!guarantor.isActive) throw new DomainError(`${guarantor.displayName} cannot act as a guarantor at present. Please choose someone else.`);
      const exposure = await guarantorExposure(tx, guarantor.id);
      if (exposure.liveCount >= guaranteeLimit)
        throw new DomainError(guaranteeLimit === 1
          ? `${guarantor.displayName} is already guaranteeing another loan. Staff may guarantee one loan at a time; please nominate someone else.`
          : `${guarantor.displayName} already has ${exposure.liveCount} live guarantee(s), the maximum allowed. Please nominate someone else.`);
      if (share && dec(exposure.total).plus(share).greaterThan(p.maxGuarantorExposure))
        throw new DomainError(`Guaranteeing this loan would take ${guarantor.displayName} above the maximum guarantor exposure. Please nominate someone else.`);
      const grec = await getStaffRecord(tx, guarantor.id);
      if (p.guarantorMustBeConfirmed && grec.profile?.employmentStatus && grec.profile.employmentStatus !== "confirmed")
        throw new DomainError(`${guarantor.displayName} can't be a guarantor yet, as guarantors need to be confirmed members of staff. Please choose another colleague.`);
      if (grec.profile?.employmentDate && grec.serviceMonths < p.guarantorMinServiceMonths)
        throw new DomainError(`${guarantor.displayName} cannot be a guarantor: guarantors need a minimum of ${serviceLength(p.guarantorMinServiceMonths)} of service.`);

      const [g] = await tx.insert(applicationGuarantors).values({ applicationId: app.id, guarantorId: guarantor.id, guaranteedAmount: m(share ?? 0), status: "pending" }).returning();
      await grantRole(tx, guarantor.id, "GUARANTOR", actor);
      await notify(tx, {
        template: "guarantor.invited", userIds: [guarantor.id], link: `/guarantor/requests/${g.id}`,
        vars: { applicantName: applicant.user.displayName, reference: app.reference, amount: fmt(app.requestedAmount), tenor: app.tenorMonths, instalment: fmt(elig.quote.monthlyInstalment), guaranteedAmount: fmt(g.guaranteedAmount) },
      });
    }

    const acceptedCount = live.filter((r) => kept.has(r.email.toLowerCase()) && r.g.status === "accepted").length;
    const needsGuarantors = p.requiredGuarantors > 0 && acceptedCount < p.requiredGuarantors;
    await transition(tx, actor, app.id, needsGuarantors ? "submit" : "submit_direct", { comment: app.status === "returned" ? "Resubmitted after correction" : null });

    await notify(tx, { template: "application.submitted", userIds: [actor.userId], link: `/applications/${app.id}`, vars: { reference: app.reference, amount: fmt(app.requestedAmount), tenor: app.tenorMonths } });
    if (!needsGuarantors) {
      await notify(tx, { template: "application.pending_hr", roles: ["HR_ADMIN"], link: `/hr/applications/${app.id}`, excludeUserIds: [actor.userId], vars: { reference: app.reference, applicantName: actor.displayName, amount: fmt(app.requestedAmount) } });
    }
    return app.id;
  });
}

function fmt(v: string) {
  return formatNaira(v);
}

export async function cancelApplication(db: Executor, actor: Actor, applicationId: string, reason: string) {
  return db.transaction(async (tx) => {
    const updated = await transition(tx, actor, applicationId, "cancel", { comment: reason || "Cancelled by applicant" });
    const gs = await tx.update(applicationGuarantors).set({ status: "withdrawn" })
      .where(and(eq(applicationGuarantors.applicationId, applicationId), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])))
      .returning({ guarantorId: applicationGuarantors.guarantorId });
    if (gs.length) await notify(tx, { template: "application.cancelled", userIds: gs.map((g) => g.guarantorId), vars: { reference: updated.reference } });
  });
}

/** Replace a declined / unresponsive guarantor while the application awaits guarantors. */
export async function replaceGuarantor(db: Executor, actor: Actor, guaranteeId: string, newEmail: string) {
  assertCan(actor, "application.create");
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(applicationGuarantors).where(eq(applicationGuarantors.id, guaranteeId)).for("update");
    if (!g) throw new NotFoundError("Guarantor request");
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, g.applicationId));
    if (app.applicantId !== actor.userId) throw new ForbiddenError();
    if (app.status !== "pending_guarantor") throw new DomainError("Guarantors can only be replaced while the application is awaiting guarantors.");
    if (g.status === "accepted") throw new DomainError("This guarantor has already accepted.");
    const policy = await getPolicyVersion(tx, app.policyVersionId);
    const email = newEmail.trim().toLowerCase();
    if (email === actor.email.toLowerCase()) throw new DomainError("You cannot nominate yourself.");
    await assertOnGuarantorList(tx, [email]);
    const guarantor = await findOrCreateStaffByEmail(tx, email, actor, (await guarantorsByEmail(tx, [email])).get(email)?.name);
    const dup = await tx.select({ id: applicationGuarantors.id }).from(applicationGuarantors).where(and(
      eq(applicationGuarantors.applicationId, app.id), eq(applicationGuarantors.guarantorId, guarantor.id), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));
    if (dup.length) throw new DomainError("That colleague is already a guarantor on this application.");
    const exposure = await guarantorExposure(tx, guarantor.id);
    const limit = (await getSettings(tx, ["lending.oneGuaranteeAtATime"]))["lending.oneGuaranteeAtATime"] ? 1 : policy.params.maxGuaranteesPerGuarantor;
    if (exposure.liveCount >= limit) throw new DomainError(limit === 1 ? `${guarantor.displayName} is already guaranteeing another loan. Staff may guarantee one loan at a time.` : `${guarantor.displayName} has reached the maximum number of active guarantees.`);
    if (dec(exposure.total).plus(g.guaranteedAmount).greaterThan(policy.params.maxGuarantorExposure)) throw new DomainError(`${guarantor.displayName} would exceed the maximum guarantor exposure.`);

    if (g.status !== "declined") await tx.update(applicationGuarantors).set({ status: "replaced" }).where(eq(applicationGuarantors.id, g.id));
    const [ng] = await tx.insert(applicationGuarantors).values({ applicationId: app.id, guarantorId: guarantor.id, guaranteedAmount: g.guaranteedAmount }).returning();
    const nominated = (app.nominatedGuarantors ?? []).filter((e) => e !== email);
    const [old] = await tx.select({ email: users.email }).from(users).where(eq(users.id, g.guarantorId));
    await tx.update(loanApplications).set({ nominatedGuarantors: [...nominated.filter((e) => e !== old?.email.toLowerCase()), email] }).where(eq(loanApplications.id, app.id));
    await grantRole(tx, guarantor.id, "GUARANTOR", actor);
    const quote = app.quote as unknown as EligibilityResult;
    await notify(tx, {
      template: "guarantor.invited", userIds: [guarantor.id], link: `/guarantor/requests/${ng.id}`,
      vars: { applicantName: actor.displayName, reference: app.reference, amount: fmt(app.requestedAmount), tenor: app.tenorMonths, instalment: fmt(quote.quote?.monthlyInstalment ?? "0"), guaranteedAmount: fmt(ng.guaranteedAmount) },
    });
    await audit(tx, actor, { action: "guarantor.replaced", entityType: "application_guarantor", entityId: ng.id, summary: `${app.reference}: replaced guarantor with ${email}` });
  });
}

export async function postMessage(db: Executor, actor: Actor, applicationId: string, kind: "clarification" | "correction" | "internal", body: string) {
  if (body.trim().length < 2) throw new DomainError("Message cannot be empty.");
  return db.transaction(async (tx) => {
    const access = await applicationAccess(tx, actor, applicationId);
    if (kind === "internal" && !access.isStaff) throw new ForbiddenError();
    // Correction requests are an HR/approver instrument; nobody else may post one.
    if (kind === "correction" && !canAny(actor, "hr.verify", "bursary.review", "approval.hr_director", "approval.decide") && !access.isHead) throw new ForbiddenError();
    if (!["clarification", "correction", "internal"].includes(kind)) throw new DomainError("Unknown message type.");
    if (!access.isApplicant && !access.isGuarantor && !access.isStaff) throw new ForbiddenError();
    await tx.insert(applicationMessages).values({ applicationId, authorId: actor.userId, kind, body: body.trim().slice(0, 4000) });
    // An applicant reply to a clarification request puts the guarantor back to "pending" decision.
    if (access.isApplicant && kind === "clarification") {
      const waiting = await tx.update(applicationGuarantors).set({ status: "pending" })
        .where(and(eq(applicationGuarantors.applicationId, applicationId), eq(applicationGuarantors.status, "clarification_requested")))
        .returning({ guarantorId: applicationGuarantors.guarantorId, id: applicationGuarantors.id });
      for (const w of waiting) {
        await notify(tx, { template: "guarantor.reminder", userIds: [w.guarantorId], link: `/guarantor/requests/${w.id}`, vars: { applicantName: actor.displayName, reference: access.app.reference } });
      }
    }
    await audit(tx, actor, { action: "application.message_posted", entityType: "loan_application", entityId: applicationId, summary: kind });
  });
}

/* ───────────────────────── Read models ───────────────────────── */

export async function applicationAccess(db: Executor, actor: Actor, applicationId: string) {
  const [app] = await db.select().from(loanApplications).where(eq(loanApplications.id, applicationId));
  if (!app) throw new NotFoundError("Application");
  const isApplicant = app.applicantId === actor.userId;
  // The applicant's Line Manager reviews it like other approvers.
  const isHead = !isApplicant && (await departmentHeadOf(db, app.applicantId))?.headUserId === actor.userId;
  const isStaff = isHead || canAny(actor, "hr.queue.view", "approval.queue.view", "accounts.view", "documents.view_all");
  const [g] = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors).where(and(
    eq(applicationGuarantors.applicationId, applicationId), eq(applicationGuarantors.guarantorId, actor.userId), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));
  return { app, isApplicant, isStaff, isHead, isGuarantor: !!g };
}

export async function getApplicationDetail(db: Executor, actor: Actor, applicationId: string) {
  const access = await applicationAccess(db, actor, applicationId);
  if (!access.isApplicant && !access.isStaff && !access.isGuarantor) throw new ForbiddenError("You do not have access to this application.");
  const app = access.app;
  const [product] = await db.select().from(loanProducts).where(eq(loanProducts.id, app.productId));
  const policy = await getPolicyVersion(db, app.policyVersionId);
  const applicant = await getStaffRecord(db, app.applicantId);
  const guarantors = await db.select({ g: applicationGuarantors, user: { id: users.id, displayName: users.displayName, email: users.email } })
    .from(applicationGuarantors).innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
    .where(eq(applicationGuarantors.applicationId, app.id)).orderBy(asc(applicationGuarantors.invitedAt));
  const history = await db.select({ t: workflowTransitions, actorName: users.displayName }).from(workflowTransitions)
    .innerJoin(users, eq(users.id, workflowTransitions.actorId))
    .where(eq(workflowTransitions.applicationId, app.id)).orderBy(asc(workflowTransitions.createdAt));
  const messages = await db.select({ msg: applicationMessages, authorName: users.displayName }).from(applicationMessages)
    .innerJoin(users, eq(users.id, applicationMessages.authorId))
    .where(and(eq(applicationMessages.applicationId, app.id), access.isStaff ? sql`true` : notInArray(applicationMessages.kind, ["internal"])))
    .orderBy(asc(applicationMessages.createdAt));
  const hr = access.isStaff ? await db.select({ v: hrVerifications, officerName: users.displayName }).from(hrVerifications).innerJoin(users, eq(users.id, hrVerifications.officerId)).where(eq(hrVerifications.applicationId, app.id)).orderBy(desc(hrVerifications.createdAt)) : [];
  const approvalRows = access.isStaff || access.isApplicant
    ? await db.select({ a: approvals, approverName: users.displayName }).from(approvals).innerJoin(users, eq(users.id, approvals.approverId)).where(eq(approvals.applicationId, app.id)).orderBy(asc(approvals.createdAt))
    : [];
  const assessments = access.isStaff && guarantors.length
    ? await db.select().from(guarantorAssessments).where(inArray(guarantorAssessments.applicationGuarantorId, guarantors.map((g) => g.g.id))).orderBy(desc(guarantorAssessments.createdAt))
    : [];
  const [loan] = await db.select().from(loanAccounts).where(eq(loanAccounts.applicationId, app.id));
  return { app, product, policy, applicant, guarantors, history, messages, hr, approvals: approvalRows, assessments, loan: loan ?? null, access };
}

export async function listMyApplications(db: Executor, actor: Actor) {
  assertCan(actor, "application.view_own");
  return db.select({ app: loanApplications, productName: loanProducts.name, loanId: loanAccounts.id, accountNumber: loanAccounts.accountNumber }).from(loanApplications)
    .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .leftJoin(loanAccounts, eq(loanAccounts.applicationId, loanApplications.id))
    .where(eq(loanApplications.applicantId, actor.userId)).orderBy(desc(loanApplications.createdAt));
}
