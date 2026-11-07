import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { users, staffProfiles, departments, schools, staffCategories, loanAccounts, loanApplications } from "@/db/schema";
import { monthsBetween, todayLagos } from "@/lib/finance/dates";
import { m, sum } from "@/lib/finance/money";
import { encryptString } from "@/lib/security/crypto";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError, NotFoundError } from "../errors";
import { notify } from "../notifications";

export const LIVE_LOAN_STATUSES = ["pending_disbursement", "active", "overdue", "defaulted"] as const;
export const IN_FLIGHT_APP_STATUSES = ["pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "returned"] as const;

/** The name saved under My details, which comes before the Microsoft account name. */
export async function preferredName(db: Executor, userId: string, fallback: string): Promise<string> {
  const [p] = await db.select({ name: staffProfiles.payslipName }).from(staffProfiles).where(eq(staffProfiles.userId, userId));
  return p?.name?.trim() || fallback;
}

export async function getStaffRecord(db: Executor, userId: string) {
  const [row] = await db
    .select({ user: users, profile: staffProfiles, department: departments, school: schools, category: staffCategories })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .leftJoin(schools, eq(schools.id, staffProfiles.schoolId))
    .leftJoin(staffCategories, eq(staffCategories.id, staffProfiles.categoryId))
    .where(eq(users.id, userId));
  if (!row) throw new NotFoundError("Staff member");
  const p = row.profile;
  return {
    ...row,
    serviceMonths: p?.employmentDate ? monthsBetween(p.employmentDate, todayLagos()) : 0,
    salaryVerified: p?.salarySource === "hr_verified" || p?.salarySource === "payroll",
  };
}

/** The applicant's department and its Head (set by the administrator under Organisation). */
export async function departmentHeadOf(db: Executor, userId: string) {
  const [row] = await db.select({ departmentId: departments.id, department: departments.name, headUserId: departments.headUserId, approverTitle: departments.approverTitle })
    .from(staffProfiles).innerJoin(departments, eq(departments.id, staffProfiles.departmentId)).where(eq(staffProfiles.userId, userId));
  return row ?? null;
}

/** Active departments for applicants to choose from. Who approves for each is not shown to them. */
export async function departmentOptions(db: Executor) {
  return db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.isActive, true)).orderBy(departments.name);
}

/** Ids of the departments this person heads. */
export async function departmentsHeadedBy(db: Executor, userId: string): Promise<string[]> {
  return (await db.select({ id: departments.id }).from(departments).where(eq(departments.headUserId, userId))).map((d) => d.id);
}

/** Existing monthly loan deductions and live loan/application counts for affordability checks. */
export async function getObligations(db: Executor, userId: string, excludeApplicationId?: string) {
  // Normalise each loan's per-period instalment to a monthly deduction for affordability.
  const loans = await db.select({ instalment: sql<string>`${loanAccounts.monthlyInstalment} / ${loanAccounts.repaymentPeriodMonths}`, outstanding: sql<string>`${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}` })
    .from(loanAccounts)
    .where(and(eq(loanAccounts.borrowerId, userId), inArray(loanAccounts.status, [...LIVE_LOAN_STATUSES])));
  const apps = await db.select({ id: loanApplications.id }).from(loanApplications).where(and(
    eq(loanApplications.applicantId, userId), inArray(loanApplications.status, [...IN_FLIGHT_APP_STATUSES]),
    excludeApplicationId ? ne(loanApplications.id, excludeApplicationId) : sql`true`,
  ));
  return {
    monthlyDeductions: m(sum(loans.map((l) => l.instalment))),
    outstanding: m(sum(loans.map((l) => l.outstanding))),
    liveLoanCount: loans.length,
    inFlightApplications: apps.length,
  };
}

/** Self-service edits limited to contact and bank details. Employment/salary are HR-controlled. */
export async function updateOwnProfile(db: Executor, actor: Actor, input: { phone?: string; residentialAddress?: string; bankName?: string; bankAccountNumber?: string; bankAccountName?: string }) {
  assertCan(actor, "profile.edit_own");
  if (input.bankAccountNumber && !/^\d{10}$/.test(input.bankAccountNumber)) throw new DomainError("Bank account number must be a 10-digit NUBAN.");
  if (input.phone && !/^[+\d][\d\s-]{6,20}$/.test(input.phone)) throw new DomainError("Enter a valid phone number.");
  return db.transaction(async (tx) => {
    const patch: Partial<typeof staffProfiles.$inferInsert> = { updatedAt: new Date() };
    if (input.phone !== undefined) patch.phone = input.phone || null;
    if (input.residentialAddress !== undefined) patch.residentialAddress = input.residentialAddress.trim().slice(0, 300) || null;
    if (input.bankName !== undefined) patch.bankName = input.bankName || null;
    if (input.bankAccountName !== undefined) patch.bankAccountName = input.bankAccountName || null;
    if (input.bankAccountNumber) {
      patch.bankAccountNumberEnc = encryptString(input.bankAccountNumber);
      patch.bankAccountLast4 = input.bankAccountNumber.slice(-4);
    }
    await tx.insert(staffProfiles).values({ userId: actor.userId, ...patch }).onConflictDoUpdate({ target: staffProfiles.userId, set: patch });
    await audit(tx, actor, { action: "profile.updated_own", entityType: "staff_profile", entityId: actor.userId, after: { ...patch, bankAccountNumberEnc: undefined } });
  });
}

/** The name, staff number and pay grade an uploaded payslip is checked against. */
export function payslipIdentity(rec: { user: { displayName: string }; profile: { payslipName: string | null; staffNumber: string | null; payGrade: string | null } | null }) {
  return { name: rec.profile?.payslipName || rec.user.displayName, staffNumber: rec.profile?.staffNumber ?? null, payGrade: rec.profile?.payGrade ?? null };
}

/** Whether HR has confirmed the payslip details the staff member last entered. */
export function payslipDetailsConfirmed(p: { payslipDetailsConfirmedAt: Date | null; payslipDetailsUpdatedAt: Date | null } | null | undefined) {
  return !!p?.payslipDetailsConfirmedAt && (!p.payslipDetailsUpdatedAt || p.payslipDetailsConfirmedAt >= p.payslipDetailsUpdatedAt);
}

/**
 * The staff member enters their name, staff number and pay grade exactly as printed on their payslip.
 * They take effect straight away, so the payslip can be uploaded, and wait for HR to confirm them.
 */
export async function updatePayslipDetails(db: Executor, actor: Actor, input: { name: string; staffNumber: string; payGrade: string }) {
  assertCan(actor, "profile.edit_own");
  const name = input.name.replace(/\s+/g, " ").trim(), staffNumber = input.staffNumber.trim(), payGrade = input.payGrade.replace(/\s+/g, " ").trim();
  if (!name || !staffNumber || !payGrade) throw new DomainError("Enter your name, employee code and pay grade as they appear on your payslip.");
  if (name.length > 200 || staffNumber.length > 40 || payGrade.length > 120) throw new DomainError("One of the details is too long.");
  return db.transaction(async (tx) => {
    const [taken] = await tx.select({ userId: staffProfiles.userId }).from(staffProfiles).where(and(sql`lower(${staffProfiles.staffNumber}) = ${staffNumber.toLowerCase()}`, ne(staffProfiles.userId, actor.userId)));
    if (taken) throw new DomainError("This employee code is already recorded for another member of staff. Please contact Human Resources.");
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, actor.userId));
    if (before && (before.payslipName || actor.displayName) === name && before.staffNumber === staffNumber && before.payGrade === payGrade) return false;
    const patch = { payslipName: name, staffNumber, payGrade, payslipDetailsUpdatedAt: new Date(), updatedAt: new Date() };
    await tx.insert(staffProfiles).values({ userId: actor.userId, ...patch }).onConflictDoUpdate({ target: staffProfiles.userId, set: patch });
    await audit(tx, actor, { action: "profile.payslip_details", entityType: "staff_profile", entityId: actor.userId, before: before && { payslipName: before.payslipName, staffNumber: before.staffNumber, payGrade: before.payGrade }, after: { payslipName: name, staffNumber, payGrade }, summary: "Payslip details updated; awaiting Human Resources confirmation" });
    await notify(tx, { template: "staff.payslip_details", roles: ["HR_ADMIN"], excludeUserIds: [actor.userId], link: `/hr/staff/${actor.userId}`, vars: { staffName: name } });
    return true;
  });
}

/** HR confirms the payslip details a staff member entered match the personnel record. */
export async function confirmPayslipDetails(db: Executor, actor: Actor, userId: string) {
  assertCan(actor, "hr.staff.edit");
  if (userId === actor.userId) throw new DomainError("You cannot confirm your own details.");
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId));
    if (!p?.staffNumber || !p.payGrade) throw new DomainError("The staff number and pay grade must be recorded before they can be confirmed.");
    await tx.update(staffProfiles).set({ payslipDetailsConfirmedBy: actor.userId, payslipDetailsConfirmedAt: new Date() }).where(eq(staffProfiles.userId, userId));
    await audit(tx, actor, { action: "staff.payslip_details_confirmed", entityType: "staff_profile", entityId: userId, after: { payslipName: p.payslipName, staffNumber: p.staffNumber, payGrade: p.payGrade }, summary: "Payslip details confirmed by HR" });
  });
}

export interface StaffRecordInput {
  staffNumber?: string | null;
  schoolId?: string | null;
  departmentId?: string | null;
  categoryId?: string | null;
  designation?: string | null;
  /** As printed on the payslip; an uploaded payslip must match it. */
  payGrade?: string | null;
  payslipName?: string | null;
  employmentStatus?: (typeof staffProfiles.$inferInsert)["employmentStatus"];
  employmentDate?: string | null;
  confirmationDate?: string | null;
  monthlyBasic?: string | null;
  monthlyGross?: string | null;
  monthlyNet?: string | null;
}

/** HR maintenance of authoritative employment and salary records. */
/**
 * HR's Confirmed / Not confirmed switch on the staff record. Loan eligibility follows it: staff
 * marked not confirmed cannot borrow or guarantee (see assessEligibility and submitApplication).
 * "Not confirmed" records probation unless HR has already recorded another non-confirmed status.
 */
export async function setStaffConfirmation(db: Executor, actor: Actor, userId: string, confirmed: boolean) {
  assertCan(actor, "hr.staff.edit");
  if (userId === actor.userId) throw new DomainError("You cannot change your own confirmation status.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId));
    const current = before?.employmentStatus ?? null;
    const employmentStatus = confirmed ? "confirmed" as const : !current || current === "confirmed" ? "probation" as const : current;
    const patch = {
      employmentStatus, updatedAt: new Date(), employmentVerifiedBy: actor.userId, employmentVerifiedAt: new Date(),
      ...(confirmed && !before?.confirmationDate ? { confirmationDate: todayLagos() } : {}),
    };
    await tx.insert(staffProfiles).values({ userId, ...patch }).onConflictDoUpdate({ target: staffProfiles.userId, set: patch });
    await audit(tx, actor, { action: "staff.confirmation_changed", entityType: "staff_profile", entityId: userId, before: { employmentStatus: current }, after: { employmentStatus }, summary: confirmed ? "Marked as confirmed staff" : "Marked as not confirmed" });
  });
}

export async function hrUpdateStaffRecord(db: Executor, actor: Actor, userId: string, input: StaffRecordInput, note: string) {
  assertCan(actor, "hr.staff.edit");
  if (userId === actor.userId) throw new DomainError("You cannot edit your own employment or salary record.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId));
    const salaryChanged = input.monthlyBasic !== undefined || input.monthlyGross !== undefined || input.monthlyNet !== undefined;
    const patch: Partial<typeof staffProfiles.$inferInsert> = {
      ...input,
      monthlyBasic: input.monthlyBasic === undefined ? undefined : input.monthlyBasic ? m(input.monthlyBasic) : null,
      monthlyGross: input.monthlyGross === undefined ? undefined : input.monthlyGross ? m(input.monthlyGross) : null,
      monthlyNet: input.monthlyNet === undefined ? undefined : input.monthlyNet ? m(input.monthlyNet) : null,
      employmentVerifiedBy: actor.userId, employmentVerifiedAt: new Date(), updatedAt: new Date(),
      ...(salaryChanged ? { salarySource: "hr_verified" as const, salaryVerifiedBy: actor.userId, salaryVerifiedAt: new Date() } : {}),
    };
    // Payslip details entered by HR are confirmed by HR.
    const detailsChanged = (["staffNumber", "payGrade", "payslipName"] as const).some((k) => input[k] !== undefined && (input[k] ?? null) !== (before?.[k] ?? null));
    if (detailsChanged && patch.staffNumber !== null && patch.payGrade !== null) Object.assign(patch, { payslipDetailsConfirmedBy: actor.userId, payslipDetailsConfirmedAt: new Date() });
    if (patch.monthlyNet && patch.monthlyGross && Number(patch.monthlyNet) > Number(patch.monthlyGross)) throw new DomainError("Net salary cannot exceed gross salary.");
    await tx.insert(staffProfiles).values({ userId, ...patch }).onConflictDoUpdate({ target: staffProfiles.userId, set: patch });
    await audit(tx, actor, { action: "staff.record_updated", entityType: "staff_profile", entityId: userId, before, after: patch, summary: note });
  });
}
