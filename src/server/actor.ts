import type { Permission, RoleCode } from "@/lib/auth/permissions";
import { ForbiddenError } from "./errors";

/**
 * The authenticated principal performing an operation. Built from the server-side session on
 * every request (roles/permissions re-read from the database), and passed explicitly into services
 * so that every service call is authorised and audited with request context.
 */
export interface Actor {
  userId: string;
  email: string;
  displayName: string;
  roles: RoleCode[];
  permissions: ReadonlySet<Permission>;
  ip?: string | null;
  userAgent?: string | null;
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.has(permission);
}

export function canAny(actor: Actor, ...perms: Permission[]): boolean {
  return perms.some((p) => actor.permissions.has(p));
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!actor.permissions.has(permission)) throw new ForbiddenError();
}

/** The highest-privilege role label to record in workflow history for a given permission. */
export function roleFor(actor: Actor, preferred: RoleCode[]): string {
  return preferred.find((r) => actor.roles.includes(r)) ?? actor.roles[0] ?? "UNKNOWN";
}

/**
 * Who may see a person's pay: salary figures, deductions and payslips. Human Resources, the Bursary, Payroll and
 * those who see every document (the HR Director and the Bursar). A Head of Department or Line Manager approving
 * an application sees the request and the eligible amount, not the pay behind it.
 */
export function canSeePay(actor: Actor): boolean {
  return canAny(actor, "hr.queue.view", "hr.staff.view", "accounts.view", "payroll.view", "documents.view_all");
}
