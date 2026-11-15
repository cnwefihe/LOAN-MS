import { and, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { applicationGuarantors, applicationMessages, loanApplications, loanAccounts, users, loanProducts } from "@/db/schema";
import { dec, formatNaira, m, sum, ZERO } from "@/lib/finance/money";
import { guarantorCover } from "@/lib/finance/staff-eligibility";
import { formatDate, monthsBetween, todayLagos } from "@/lib/finance/dates";
import { sha256Hex } from "@/lib/security/crypto";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { notify } from "../notifications";
import { transition } from "../workflow";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import { getActiveTerms, getPolicyVersion } from "./policies";
import { getSettings } from "../settings";
import { attachGuarantorPayslip, latestPayslip } from "./payslips";
import { monthsText } from "@/lib/finance/dates";

/** Relationship with the applicant, as asked on the guarantor's form. */
export const GUARANTOR_RELATIONSHIPS = ["Colleague", "Line manager", "Friend", "Relative", "Other"] as const;

export const LIVE_GUARANTEE_STATUSES = ["pending", "accepted", "clarification_requested"] as const;
const LIVE_APP = ["pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "returned", "approved"] as const;

export interface ExposureItem {
  guaranteeId: string;
  applicationId: string;
  reference: string;
  applicantName: string;
  status: string;
  applicationStatus: string;
  loanStatus: string | null;
  guaranteedAmount: string;
  currentExposure: string;
  /** What the guarantor could be asked to pay each month if the borrower stopped paying: exposure spread over the months left. */
  monthlyCommitment: string;
  /** Months over which that commitment is spread (to the loan's final due date, or the requested tenor). */
  monthsLeft: number;
}

/**
 * A guarantor's current and potential liability:
 *  - pending / in-flight applications: the full guaranteed amount (potential liability)
 *  - disbursed loans: guaranteed share × (outstanding ÷ total repayable)
 *  - closed / cancelled / declined: nil
 */
export async function guarantorExposure(db: Executor, guarantorId: string): Promise<{ items: ExposureItem[]; total: string; liveCount: number; potential: string; actual: string; monthlyCommitment: string }> {
  const rows = await db
    .select({ g: applicationGuarantors, app: loanApplications, applicantName: users.displayName, loan: loanAccounts })
    .from(applicationGuarantors)
    .innerJoin(loanApplications, eq(loanApplications.id, applicationGuarantors.applicationId))
    .innerJoin(users, eq(users.id, loanApplications.applicantId))
    .leftJoin(loanAccounts, eq(loanAccounts.applicationId, loanApplications.id))
    .where(and(eq(applicationGuarantors.guarantorId, guarantorId), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES]), inArray(loanApplications.status, [...LIVE_APP])));
  let potential = ZERO;
  let actual = ZERO;
  const items: ExposureItem[] = [];
  for (const r of rows) {
    let exposure = dec(r.g.guaranteedAmount);
    if (r.loan) {
      if (r.loan.status === "closed" || r.loan.status === "cancelled" || r.loan.status === "written_off") continue;
      if (r.loan.status !== "pending_disbursement" && dec(r.loan.totalRepayable).greaterThan(0)) {
        const outstanding = dec(r.loan.principalOutstanding).plus(r.loan.interestOutstanding);
        exposure = exposure.times(outstanding).div(r.loan.totalRepayable);
        actual = actual.plus(exposure);
      } else potential = potential.plus(exposure);
    } else potential = potential.plus(exposure);
    const monthsLeft = r.loan?.maturityDate && r.loan.status !== "pending_disbursement"
      ? Math.max(1, monthsBetween(todayLagos(), r.loan.maturityDate) + 1)
      : Math.max(1, r.app.tenorMonths);
    items.push({
      monthlyCommitment: m(exposure.div(monthsLeft)), monthsLeft,
      guaranteeId: r.g.id, applicationId: r.app.id, reference: r.app.reference, applicantName: r.applicantName, status: r.g.status,
      applicationStatus: r.app.status, loanStatus: r.loan?.status ?? null, guaranteedAmount: r.g.guaranteedAmount, currentExposure: m(exposure),
    });
  }
  return { items, total: m(sum(items.map((i) => i.currentExposure))), liveCount: items.length, potential: m(potential), actual: m(actual), monthlyCommitment: m(sum(items.map((i) => i.monthlyCommitment))) };
}

export async function listMyGuarantees(db: Executor, actor: Actor) {
  assertCan(actor, "guarantee.view_own");
  return db.select({ g: applicationGuarantors, app: loanApplications, applicantName: users.displayName, productName: loanProducts.name })
    .from(applicationGuarantors)
    .innerJoin(loanApplications, eq(loanApplications.id, applicationGuarantors.applicationId))
    .innerJoin(users, eq(users.id, loanApplications.applicantId))
    .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .where(eq(applicationGuarantors.guarantorId, actor.userId))
    .orderBy(desc(applicationGuarantors.invitedAt));
}

export async function getGuaranteeForGuarantor(db: Executor, actor: Actor, guaranteeId: string) {
  assertCan(actor, "guarantee.view_own");
  const [g] = await db.select().from(applicationGuarantors).where(eq(applicationGuarantors.id, guaranteeId));
  if (!g) throw new NotFoundError("Guarantor request");
  if (g.guarantorId !== actor.userId) throw new ForbiddenError();
  return g;
}

/** Text the guarantor acknowledges; its hash (with the obligation figures) is stored as evidence. */
export function guarantorAcknowledgementText(opts: { termsBody: string; termsVersion: number; reference: string; applicantName: string; guaranteedAmount: string; totalRepayable: string; tenor: number; instalment: string; guarantorName: string; guarantorEmail: string }) {
  return [
    `GUARANTOR AGREEMENT v${opts.termsVersion}`,
    opts.termsBody,
    `Application: ${opts.reference}`,
    `Borrower: ${opts.applicantName}`,
    `Total repayable by borrower: ${opts.totalRepayable} over ${monthsText(opts.tenor)} (monthly ${opts.instalment})`,
    `Amount guaranteed by me: ${opts.guaranteedAmount}`,
    `Guarantor: ${opts.guarantorName} <${opts.guarantorEmail}>`,
  ].join("\n");
}

export type GuarantorDecision =
  | { decision: "accept"; typedName: string; confirmations: boolean[]; relationship: string; phone: string }
  | { decision: "decline"; reason: string }
  | { decision: "clarify"; question: string };

/**
 * The figures behind the guarantor's cover check for one guarantee: their latest payslip (whose deductions
 * include their own loan repayments), what the other loans they guarantee could cost them each month, and
 * their share of this one a month.
 */
export async function guarantorCoverInputs(db: Executor, guarantorId: string, guaranteeId: string) {
  const exposure = await guarantorExposure(db, guarantorId);
  const self = exposure.items.find((i) => i.guaranteeId === guaranteeId);
  const monthlyShare = self?.monthlyCommitment ?? "0.00";
  const slip = await latestPayslip(db, guarantorId);
  return { payslip: slip?.data ?? null, payslipId: slip?.id ?? null, uploaded: slip ? { id: slip.id, period: slip.period, uploadedOn: formatDate(slip.createdAt) } : null, otherGuarantees: m(dec(exposure.monthlyCommitment).minus(monthlyShare)), monthlyShare, monthsLeft: self?.monthsLeft ?? 0 };
}

export async function respondToGuarantee(db: Executor, actor: Actor, guaranteeId: string, input: GuarantorDecision) {
  assertCan(actor, "guarantee.respond");
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(applicationGuarantors).where(eq(applicationGuarantors.id, guaranteeId)).for("update");
    if (!g) throw new NotFoundError("Guarantor request");
    if (g.guarantorId !== actor.userId) throw new ForbiddenError();
    if (g.status !== "pending" && g.status !== "clarification_requested") throw new DomainError("You have already responded to this request.");
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, g.applicationId));
    if (app.status !== "pending_guarantor") throw new DomainError("This application is no longer awaiting guarantor responses.");
    const [applicant] = await tx.select().from(users).where(eq(users.id, app.applicantId));
    const vars = { guarantorName: actor.displayName, reference: app.reference };

    if (input.decision === "accept") {
      if ((await getSettings(tx, ["lending.oneGuaranteeAtATime"]))["lending.oneGuaranteeAtATime"]) {
        const others = (await guarantorExposure(tx, actor.userId)).items.filter((i) => i.applicationId !== g.applicationId && i.status === "accepted");
        if (others.length) throw new DomainError(`You are already guaranteeing ${others[0].applicantName}'s loan (${others[0].reference}). Staff may guarantee one loan at a time.`);
      }
      if (!input.confirmations.length || input.confirmations.some((c) => !c)) throw new DomainError("Please confirm each statement in the guarantor agreement.");
      // The guarantor must be able to cover their share from their own pay if the borrower stops paying.
      const inputs = await guarantorCoverInputs(tx, actor.userId, g.id);
      if (!inputs.payslip || !inputs.payslipId) throw new DomainError("Upload your latest payslip first.");
      const policyForCover = await getPolicyVersion(tx, app.policyVersionId);
      const cover = guarantorCover(policyForCover.params, { ...inputs, payslip: inputs.payslip, asOf: todayLagos() });
      if (cover.payslip.problems.length) throw new DomainError(cover.payslip.problems.join(" "));
      if (!cover.ok) throw new DomainError(`On your payslip, ${formatNaira(cover.available)} a month is left within the ${cover.payslip.capPercent}% deduction limit, less than your share of ${formatNaira(cover.monthlyShare)} a month. You may decline this request.`);
      if (!GUARANTOR_RELATIONSHIPS.includes(input.relationship as never)) throw new DomainError("State your relationship with the applicant.");
      if (!/^[+\d][\d\s-]{6,20}(\s*[,/]\s*[+\d][\d\s-]{6,20})?$/.test(input.phone.trim())) throw new DomainError("Enter a valid phone number (two may be separated by a comma).");
      if (input.typedName.trim().toLowerCase() !== actor.displayName.trim().toLowerCase()) {
        throw new DomainError(`Type your full name exactly as "${actor.displayName}" to sign electronically.`);
      }
      const terms = await getActiveTerms(tx, "guarantor_agreement");
      if (!terms) throw new DomainError("The guarantor agreement has not been published. Contact the Bursary.");
      const quote = (app.quote as unknown as EligibilityResult).quote;
      const text = guarantorAcknowledgementText({
        termsBody: terms.body, termsVersion: terms.version, reference: app.reference, applicantName: applicant.displayName,
        guaranteedAmount: g.guaranteedAmount, totalRepayable: quote?.totalRepayable ?? app.requestedAmount, tenor: app.tenorMonths,
        instalment: quote?.monthlyInstalment ?? "", guarantorName: actor.displayName, guarantorEmail: actor.email,
      });
      await tx.update(applicationGuarantors).set({
        status: "accepted", respondedAt: new Date(), agreementTermsId: terms.id, agreementVersion: terms.version,
        acknowledgementHash: sha256Hex(text), acknowledgedName: input.typedName.trim(), acknowledgedEmail: actor.email,
        acknowledgedIp: actor.ip ?? null, acknowledgedUserAgent: actor.userAgent ?? null, relationship: input.relationship, guarantorPhone: input.phone.trim(), declaredBasic: cover.payslip.basic, payslipId: inputs.payslipId,
      }).where(eq(applicationGuarantors.id, g.id));
      await attachGuarantorPayslip(tx, actor, app.id, g.id, inputs.payslipId);
      await audit(tx, actor, { action: "guarantee.accepted", entityType: "application_guarantor", entityId: g.id, summary: `${app.reference}: accepted guarantee of ${g.guaranteedAmount}`, after: { agreementVersion: terms.version, hash: sha256Hex(text) } });
      await notify(tx, { template: "guarantor.accepted", userIds: [app.applicantId], link: `/applications/${app.id}`, vars });

      const policy = await getPolicyVersion(tx, app.policyVersionId);
      const accepted = await tx.select({ id: applicationGuarantors.id }).from(applicationGuarantors)
        .where(and(eq(applicationGuarantors.applicationId, app.id), eq(applicationGuarantors.status, "accepted")));
      if (accepted.length >= policy.params.requiredGuarantors) {
        await transition(tx, actor, app.id, "guarantors_complete", { comment: `${accepted.length} guarantor(s) accepted` });
        await notify(tx, { template: "application.pending_hr", roles: ["HR_ADMIN"], link: `/hr/applications/${app.id}`, excludeUserIds: [app.applicantId], vars: { reference: app.reference, applicantName: applicant.displayName, amount: app.requestedAmount } });
      }
      return "accepted";
    }

    if (input.decision === "decline") {
      if (input.reason.trim().length < 3) throw new DomainError("Please give a brief reason for declining.");
      await tx.update(applicationGuarantors).set({ status: "declined", respondedAt: new Date(), responseComment: input.reason.trim() }).where(eq(applicationGuarantors.id, g.id));
      await audit(tx, actor, { action: "guarantee.declined", entityType: "application_guarantor", entityId: g.id, summary: `${app.reference}: ${input.reason}` });
      await notify(tx, { template: "guarantor.declined", userIds: [app.applicantId], link: `/applications/${app.id}`, vars: { ...vars, comment: input.reason.trim() } });
      return "declined";
    }

    if (input.question.trim().length < 5) throw new DomainError("Please write your question for the applicant.");
    await tx.update(applicationGuarantors).set({ status: "clarification_requested", responseComment: input.question.trim() }).where(eq(applicationGuarantors.id, g.id));
    await tx.insert(applicationMessages).values({ applicationId: app.id, authorId: actor.userId, kind: "clarification", body: input.question.trim() });
    await audit(tx, actor, { action: "guarantee.clarification_requested", entityType: "application_guarantor", entityId: g.id, summary: app.reference });
    await notify(tx, { template: "guarantor.clarification", userIds: [app.applicantId], link: `/applications/${app.id}`, vars: { ...vars, comment: input.question.trim() } });
    return "clarification_requested";
  });
}
