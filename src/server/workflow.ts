/**
 * Approval workflow engine. Every application status change goes through `transition()`, which
 * enforces the allowed state machine, the actor's permission, segregation of duties and
 * optimistic concurrency, and records an immutable workflow_transitions row + audit entry.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanApplications, workflowTransitions, applicationGuarantors } from "@/db/schema";
import type { Permission, RoleCode } from "@/lib/auth/permissions";
import { type Actor, roleFor } from "./actor";
import { audit } from "./audit";
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from "./errors";

export type AppStatus = (typeof loanApplications.$inferSelect)["status"];

interface Rule {
  from: AppStatus[];
  to: AppStatus;
  /** null = system transition (triggered by another business event, actor still recorded). */
  permission: Permission | null;
  ownerOnly?: boolean;
  /** Staff acting on the application must not be the applicant or one of its guarantors. */
  independent?: boolean;
  roles: RoleCode[];
  /** Recorded as the actor's role when the right comes from something other than a role (the Line Manager). */
  actorLabel?: string;
  label: string;
}

/**
 * After the Bursary Officer, an application stays "pending_approval" while it passes three approvals,
 * held in currentApprovalLevel: 1 Line Manager, 2 HR Director, 3 Bursar (final).
 */
export const APPROVAL_LEVEL = { HOD: 1, HR_DIRECTOR: 2, BURSAR: 3 } as const;

export const WORKFLOW: Record<string, Rule> = {
  submit: { from: ["draft", "returned"], to: "pending_guarantor", permission: "application.create", ownerOnly: true, roles: ["APPLICANT"], label: "Submitted" },
  submit_direct: { from: ["draft", "returned"], to: "pending_hr", permission: "application.create", ownerOnly: true, roles: ["APPLICANT"], label: "Submitted (no guarantor required)" },
  guarantors_complete: { from: ["pending_guarantor"], to: "pending_hr", permission: null, roles: ["GUARANTOR"], label: "All guarantors accepted" },
  hr_verify: { from: ["pending_hr"], to: "pending_bursary", permission: "hr.verify", independent: true, roles: ["HR_ADMIN"], label: "Verified by Human Resources and forwarded to the Bursary Officer" },
  hr_return: { from: ["pending_hr"], to: "returned", permission: "hr.verify", independent: true, roles: ["HR_ADMIN"], label: "Returned by Human Resources for correction" },
  hr_decline: { from: ["pending_hr"], to: "declined", permission: "hr.verify", independent: true, roles: ["HR_ADMIN"], label: "Declined by Human Resources" },
  bursary_clear: { from: ["pending_bursary"], to: "pending_approval", permission: "bursary.review", independent: true, roles: ["BURSARY_OFFICER"], label: "Affirmed by the Bursary Officer and sent for approval" },
  bursary_return: { from: ["pending_bursary"], to: "returned", permission: "bursary.review", independent: true, roles: ["BURSARY_OFFICER"], label: "Returned to applicant by the Bursary Officer" },
  bursary_refer_hr: { from: ["pending_bursary"], to: "pending_hr", permission: "bursary.review", independent: true, roles: ["BURSARY_OFFICER"], label: "Referred back to Human Resources by the Bursary Officer" },
  bursary_decline: { from: ["pending_bursary"], to: "declined", permission: "bursary.review", independent: true, roles: ["BURSARY_OFFICER"], label: "Declined by the Bursary Officer" },
  // Line Manager: the right comes from heading the applicant's department (checked by the approvals service).
  hod_approve: { from: ["pending_approval"], to: "pending_approval", permission: null, actorLabel: "HEAD_OF_DEPARTMENT", independent: true, roles: [], label: "Approved by the Line Manager" },
  hod_decline: { from: ["pending_approval"], to: "declined", permission: null, actorLabel: "HEAD_OF_DEPARTMENT", independent: true, roles: [], label: "Declined by the Line Manager" },
  hod_return: { from: ["pending_approval"], to: "returned", permission: null, actorLabel: "HEAD_OF_DEPARTMENT", independent: true, roles: [], label: "Returned to applicant by the Line Manager" },
  hrd_approve: { from: ["pending_approval"], to: "pending_approval", permission: "approval.hr_director", independent: true, roles: ["HR_DIRECTOR"], label: "Approved by the HR Director" },
  hrd_decline: { from: ["pending_approval"], to: "declined", permission: "approval.hr_director", independent: true, roles: ["HR_DIRECTOR"], label: "Declined by the HR Director" },
  hrd_return: { from: ["pending_approval"], to: "returned", permission: "approval.hr_director", independent: true, roles: ["HR_DIRECTOR"], label: "Returned to applicant by the HR Director" },
  approve: { from: ["pending_approval"], to: "approved", permission: "approval.decide", independent: true, roles: ["ACCOUNTS_ADMIN"], label: "Final approval granted by the Bursar" },
  approver_decline: { from: ["pending_approval"], to: "declined", permission: "approval.decide", independent: true, roles: ["ACCOUNTS_ADMIN"], label: "Declined by the Bursar" },
  approver_return: { from: ["pending_approval"], to: "returned", permission: "approval.decide", independent: true, roles: ["ACCOUNTS_ADMIN"], label: "Returned to applicant by the Bursar" },
  refer_to_hr: { from: ["pending_approval"], to: "pending_hr", permission: "approval.decide", independent: true, roles: ["ACCOUNTS_ADMIN"], label: "Referred back to Human Resources by the Bursar" },
  cancel: { from: ["draft", "pending_guarantor", "pending_hr", "pending_bursary", "returned", "pending_approval"], to: "cancelled", permission: "application.view_own", ownerOnly: true, roles: ["APPLICANT"], label: "Cancelled by applicant" },
};

export type WorkflowAction = keyof typeof WORKFLOW;

export async function transition(
  db: Executor,
  actor: Actor,
  applicationId: string,
  action: WorkflowAction,
  opts: { comment?: string | null; patch?: Partial<typeof loanApplications.$inferInsert>; expectedRowVersion?: number } = {},
) {
  const rule = WORKFLOW[action];
  const [app] = await db.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).for("update");
  if (!app) throw new NotFoundError("Application");
  if (opts.expectedRowVersion !== undefined && opts.expectedRowVersion !== app.rowVersion) throw new ConflictError();
  if (!rule.from.includes(app.status)) {
    throw new DomainError(`This application is "${app.status.replace("_", " ")}" and cannot be ${rule.label.toLowerCase()} at this stage.`);
  }
  if (rule.permission && !actor.permissions.has(rule.permission)) throw new ForbiddenError();
  if (rule.ownerOnly && app.applicantId !== actor.userId) throw new ForbiddenError("Only the applicant can perform this action.");
  if (rule.independent) {
    if (app.applicantId === actor.userId) throw new ForbiddenError("You cannot process your own loan application (segregation of duties).");
    const [g] = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors).where(and(
      eq(applicationGuarantors.applicationId, applicationId), eq(applicationGuarantors.guarantorId, actor.userId),
      inArray(applicationGuarantors.status, ["pending", "accepted", "clarification_requested"]),
    ));
    if (g) throw new ForbiddenError("You are a guarantor on this application and cannot process it (conflict of interest).");
  }

  const terminal = rule.to === "approved" || rule.to === "declined" || rule.to === "cancelled";
  const [updated] = await db.update(loanApplications).set({
    ...opts.patch,
    status: rule.to,
    rowVersion: app.rowVersion + 1,
    updatedAt: new Date(),
    ...(terminal ? { decidedAt: new Date() } : {}),
  }).where(and(eq(loanApplications.id, applicationId), eq(loanApplications.rowVersion, app.rowVersion))).returning();
  if (!updated) throw new ConflictError();

  await db.insert(workflowTransitions).values({
    applicationId, action, fromStatus: app.status, toStatus: rule.to, actorId: actor.userId,
    actorRole: rule.actorLabel ?? (rule.permission ? roleFor(actor, rule.roles) : "SYSTEM"), comment: opts.comment ?? null,
  });
  await audit(db, actor, {
    action: `application.${action}`, entityType: "loan_application", entityId: applicationId,
    summary: `${app.reference}: ${app.status} → ${rule.to}${opts.comment ? `: ${opts.comment}` : ""}`,
    before: { status: app.status }, after: { status: rule.to, ...(opts.patch ?? {}) },
  });
  return updated;
}
