/**
 * Loan Management System: relational schema.
 *
 * Design rules:
 *  - Money is always numeric(18,2) and handled as strings / Decimal in code (never JS floats).
 *  - An application (request) is distinct from a loan account (approved, contractual loan),
 *    and both are distinct from financial transactions + ledger entries (what actually happened).
 *  - Ledger entries, audit logs and posted transactions are append-only; this is enforced by
 *    database triggers in the custom migration (drizzle/0001_integrity_triggers.sql).
 */
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, varchar, integer, boolean, timestamp, date, numeric, jsonb,
  bigserial, primaryKey, uniqueIndex, index, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const rate = (name: string) => numeric(name, { precision: 9, scale: 4 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ───────────────────────────── Enums ───────────────────────────── */

export const employmentStatusEnum = pgEnum("employment_status", ["probation", "confirmed", "contract", "suspended", "on_leave", "exited"]);
export const salarySourceEnum = pgEnum("salary_source", ["unverified", "self_declared", "hr_verified", "payroll"]);
export const policyStatusEnum = pgEnum("policy_status", ["draft", "pending_approval", "active", "retired", "rejected"]);
export const applicationStatusEnum = pgEnum("application_status", [
  "draft", "pending_guarantor", "pending_hr", "pending_bursary", "returned", "pending_approval", "approved", "declined", "cancelled",
]);
export const guarantorStatusEnum = pgEnum("guarantor_status", ["pending", "accepted", "declined", "clarification_requested", "withdrawn", "replaced"]);
export const assessmentOutcomeEnum = pgEnum("assessment_outcome", ["capable", "not_capable", "needs_review"]);
export const hrOutcomeEnum = pgEnum("hr_outcome", ["verified", "declined", "returned"]);
export const approvalDecisionEnum = pgEnum("approval_decision", ["approved", "declined", "returned", "escalated"]);
export const loanStatusEnum = pgEnum("loan_status", ["pending_disbursement", "active", "overdue", "defaulted", "closed", "written_off", "cancelled"]);
export const agreementTypeEnum = pgEnum("agreement_type", ["loan", "guarantor"]);
export const disbursementStatusEnum = pgEnum("disbursement_status", ["pending_confirmation", "confirmed", "rejected"]);
export const paymentMethodEnum = pgEnum("payment_method", ["bank_transfer", "cheque", "internal_transfer", "payroll"]);
export const instalmentStatusEnum = pgEnum("instalment_status", ["pending", "partial", "paid", "overdue", "superseded"]);
export const claimStatusEnum = pgEnum("claim_status", ["pending", "confirmed", "rejected"]);
export const txnTypeEnum = pgEnum("txn_type", [
  "disbursement", "repayment", "early_settlement", "adjustment", "reversal", "interest_recognition", "interest_rebate", "fee", "refund", "write_off",
]);
export const txnStatusEnum = pgEnum("txn_status", ["pending_approval", "posted", "rejected"]);
export const ledgerAccountEnum = pgEnum("ledger_account", [
  "loan_principal", "interest_receivable", "unearned_interest", "cash_bank", "fee_income", "overpayment_liability", "adjustments",
]);
export const entryDirectionEnum = pgEnum("entry_direction", ["debit", "credit"]);
export const restructureStatusEnum = pgEnum("restructure_status", ["pending", "approved", "rejected", "withdrawn"]);
export const emailStatusEnum = pgEnum("email_status", ["queued", "sent", "failed", "not_configured"]);

/* ─────────────────────── Identity, RBAC, sessions ─────────────────────── */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Microsoft Entra object id (oid claim). Null only for development fixture accounts. */
  entraOid: varchar("entra_oid", { length: 64 }).unique(),
  entraTenantId: varchar("entra_tenant_id", { length: 64 }),
  email: varchar("email", { length: 320 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  /** Set by an administrator: Microsoft no longer replaces the display name at sign-in. */
  nameLocked: boolean("name_locked").notNull().default(false),
  givenName: varchar("given_name", { length: 100 }),
  surname: varchar("surname", { length: 100 }),
  isActive: boolean("is_active").notNull().default(true),
  isDevFixture: boolean("is_dev_fixture").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  /** Two-step verification (TOTP): the authenticator secret, encrypted at rest. */
  mfaSecret: text("mfa_secret"),
  mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
  /** SHA-256 hashes of unused one-time recovery codes. */
  mfaRecoveryHashes: jsonb("mfa_recovery_hashes").$type<string[]>(),
  /** Encrypted secret and recovery codes awaiting confirmation during set-up. */
  mfaPending: text("mfa_pending"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)]);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(true),
  createdAt: createdAt(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 80 }).notNull().unique(),
  description: text("description").notNull(),
  category: varchar("category", { length: 50 }).notNull(),
});

export const rolePermissions = pgTable("role_permissions", {
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })]);

export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => users.id),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  assignedBy: uuid("assigned_by").references(() => users.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.roleId] })]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** SHA-256 of the opaque session token; the raw token only lives in the httpOnly cookie. */
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id),
  authMethod: varchar("auth_method", { length: 20 }).notNull(), // "entra" | "dev_fixture"
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** When the second sign-in step was completed for this session (authenticator code or Microsoft MFA). */
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/* ───────────────────────────── Organisation ───────────────────────────── */

export const schools = pgTable("schools", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  /** Line Manager: approves their staff's loan applications after the Bursary Officer. */
  headUserId: uuid("head_user_id").references(() => users.id),
  /** Whether that person is the department's HOD or, for a unit without one, its Line Manager. */
  approverTitle: varchar("approver_title", { length: 20 }).$type<"hod" | "line_manager">().notNull().default("hod"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

export const staffCategories = pgTable("staff_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 30 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const staffProfiles = pgTable("staff_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  staffNumber: varchar("staff_number", { length: 40 }).unique(),
  schoolId: uuid("school_id").references(() => schools.id),
  departmentId: uuid("department_id").references(() => departments.id),
  categoryId: uuid("category_id").references(() => staffCategories.id),
  designation: varchar("designation", { length: 150 }),
  /** Pay grade as printed on the payslip (e.g. "Assistant Manager I Step 1"); a payslip must match it. */
  payGrade: varchar("pay_grade", { length: 120 }),
  /** Full name as printed on the payslip, when it differs from the directory name. */
  payslipName: varchar("payslip_name", { length: 200 }),
  /** Payslip details (name, staff number, pay grade) last changed by the staff member; awaiting HR while not confirmed. */
  payslipDetailsUpdatedAt: timestamp("payslip_details_updated_at", { withTimezone: true }),
  payslipDetailsConfirmedBy: uuid("payslip_details_confirmed_by").references((): AnyPgColumn => users.id),
  payslipDetailsConfirmedAt: timestamp("payslip_details_confirmed_at", { withTimezone: true }),
  entraJobTitle: varchar("entra_job_title", { length: 150 }),
  entraDepartment: varchar("entra_department", { length: 150 }),
  phone: varchar("phone", { length: 30 }),
  residentialAddress: text("residential_address"),
  employmentStatus: employmentStatusEnum("employment_status"),
  employmentDate: date("employment_date"),
  confirmationDate: date("confirmation_date"),
  monthlyBasic: money("monthly_basic"),
  monthlyGross: money("monthly_gross"),
  monthlyNet: money("monthly_net"),
  salarySource: salarySourceEnum("salary_source").notNull().default("unverified"),
  salaryVerifiedBy: uuid("salary_verified_by").references(() => users.id),
  salaryVerifiedAt: timestamp("salary_verified_at", { withTimezone: true }),
  employmentVerifiedBy: uuid("employment_verified_by").references(() => users.id),
  employmentVerifiedAt: timestamp("employment_verified_at", { withTimezone: true }),
  bankName: varchar("bank_name", { length: 120 }),
  /** AES-256-GCM ciphertext (see lib/security/crypto.ts). */
  bankAccountNumberEnc: text("bank_account_number_enc"),
  bankAccountLast4: varchar("bank_account_last4", { length: 4 }),
  bankAccountName: varchar("bank_account_name", { length: 200 }),
  updatedAt: updatedAt(),
}, (t) => [index("staff_profiles_dept_idx").on(t.departmentId)]);

/* ───────────────────────── Products & policy engine ───────────────────────── */

export const loanProducts = pgTable("loan_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 30 }).notNull().unique(),
  name: varchar("name", { length: 150 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Immutable once active. Each approved loan references the exact version it was
 * priced under, so policy changes never silently modify existing agreements.
 */
export const policyVersions = pgTable("policy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull().references(() => loanProducts.id),
  version: integer("version").notNull(),
  status: policyStatusEnum("status").notNull().default("draft"),
  parameters: jsonb("parameters").notNull(),
  changeNote: text("change_note"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  submittedBy: uuid("submitted_by").references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("policy_versions_product_version_uq").on(t.productId, t.version),
  uniqueIndex("policy_versions_one_active_uq").on(t.productId).where(sql`${t.status} = 'active'`),
]);

export const termsDocuments = pgTable("terms_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: varchar("kind", { length: 30 }).notNull(), // "loan_terms" | "guarantor_agreement"
  version: integer("version").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("terms_kind_version_uq").on(t.kind, t.version),
  uniqueIndex("terms_one_active_uq").on(t.kind).where(sql`${t.isActive} = true`),
]);

export const documentRequirements = pgTable("document_requirements", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").references(() => loanProducts.id),
  code: varchar("code", { length: 50 }).notNull(),
  label: varchar("label", { length: 200 }).notNull(),
  appliesTo: varchar("applies_to", { length: 20 }).notNull().default("applicant"), // applicant | guarantor
  isRequired: boolean("is_required").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [uniqueIndex("doc_req_product_code_uq").on(t.productId, t.code)]);

/* ───────────────────────────── Applications ───────────────────────────── */

export const loanApplications = pgTable("loan_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  reference: varchar("reference", { length: 30 }).notNull().unique(),
  applicantId: uuid("applicant_id").notNull().references(() => users.id),
  productId: uuid("product_id").notNull().references(() => loanProducts.id),
  policyVersionId: uuid("policy_version_id").notNull().references(() => policyVersions.id),
  status: applicationStatusEnum("status").notNull().default("draft"),
  requestedAmount: money("requested_amount").notNull(),
  tenorMonths: integer("tenor_months").notNull(),
  purpose: text("purpose").notNull(),
  /** Salary + employment snapshot at submission (declared by applicant / taken from verified profile). */
  salarySnapshot: jsonb("salary_snapshot").notNull(),
  /** Full eligibility + repayment quote computed server-side at submission. */
  quote: jsonb("quote").notNull(),
  eligibleAmount: money("eligible_amount"),
  /** For an advance: whether it is against salary or leave allowance (null for loans). */
  advanceType: varchar("advance_type", { length: 20 }).$type<"salary" | "leave_allowance" | "thirteenth_month">(),
  /** For a leave allowance advance: the allowance amount the applicant gave. */
  advanceBaseAmount: money("advance_base_amount"),
  /** Monthly deduction for a loan from the cooperative (null: none declared). Counts against take-home pay. */
  cooperativeMonthlyDeduction: money("cooperative_monthly_deduction"),
  /** Outstanding cooperative loan balance, for HR and the Bursary to see. */
  cooperativeBalance: money("cooperative_balance"),
  /** The payslip the application was assessed on. */
  payslipId: uuid("payslip_id").references((): AnyPgColumn => staffPayslips.id),
  /** Guarantor emails held on the draft; invitations are only created on submission. */
  nominatedGuarantors: jsonb("nominated_guarantors").$type<string[]>().notNull().default([]),
  currentApprovalLevel: integer("current_approval_level").notNull().default(0),
  isEscalated: boolean("is_escalated").notNull().default(false),
  termsDocumentId: uuid("terms_document_id").references(() => termsDocuments.id),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Optimistic concurrency token: incremented on every status change. */
  rowVersion: integer("row_version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("applications_applicant_idx").on(t.applicantId),
  index("applications_status_idx").on(t.status),
  check("applications_amount_positive", sql`${t.requestedAmount} > 0`),
  check("applications_tenor_positive", sql`${t.tenorMonths} > 0`),
]);

export const applicationGuarantors = pgTable("application_guarantors", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  guarantorId: uuid("guarantor_id").notNull().references(() => users.id),
  /** The basic salary the guarantor gave when accepting, used to check they could cover their share. */
  declaredBasic: money("declared_basic"),
  /** The payslip the guarantor gave when accepting, used to check they could cover their share. */
  payslipId: uuid("payslip_id").references((): AnyPgColumn => staffPayslips.id),
  status: guarantorStatusEnum("status").notNull().default("pending"),
  /** Share of the total obligation this guarantor is liable for. */
  guaranteedAmount: money("guaranteed_amount").notNull(),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseComment: text("response_comment"),
  agreementTermsId: uuid("agreement_terms_id").references(() => termsDocuments.id),
  agreementVersion: integer("agreement_version"),
  /** SHA-256 of the exact agreement text + obligation figures acknowledged. */
  acknowledgementHash: varchar("acknowledgement_hash", { length: 64 }),
  acknowledgedName: varchar("acknowledged_name", { length: 200 }),
  acknowledgedEmail: varchar("acknowledged_email", { length: 320 }),
  acknowledgedIp: varchar("acknowledged_ip", { length: 64 }),
  acknowledgedUserAgent: text("acknowledged_user_agent"),
  /** Guarantor's form: relationship with the applicant and contact number given on acceptance. */
  relationship: varchar("relationship", { length: 60 }),
  guarantorPhone: varchar("guarantor_phone", { length: 60 }),
  createdAt: createdAt(),
}, (t) => [
  index("app_guarantors_guarantor_idx").on(t.guarantorId),
  index("app_guarantors_app_idx").on(t.applicationId),
  uniqueIndex("app_guarantors_live_uq").on(t.applicationId, t.guarantorId).where(sql`${t.status} not in ('withdrawn','replaced','declined')`),
]);

export const guarantorAssessments = pgTable("guarantor_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationGuarantorId: uuid("application_guarantor_id").notNull().references(() => applicationGuarantors.id),
  assessedBy: uuid("assessed_by").notNull().references(() => users.id),
  outcome: assessmentOutcomeEnum("outcome").notNull(),
  existingExposure: money("existing_exposure").notNull(),
  monthlyNetAtAssessment: money("monthly_net_at_assessment"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const hrVerifications = pgTable("hr_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  officerId: uuid("officer_id").notNull().references(() => users.id),
  outcome: hrOutcomeEnum("outcome").notNull(),
  employmentVerified: boolean("employment_verified").notNull(),
  salaryVerified: boolean("salary_verified").notNull(),
  staffStatusVerified: boolean("staff_status_verified").notNull(),
  departmentVerified: boolean("department_verified").notNull(),
  serviceMonths: integer("service_months"),
  verifiedMonthlyBasic: money("verified_monthly_basic"),
  verifiedMonthlyGross: money("verified_monthly_gross"),
  verifiedMonthlyNet: money("verified_monthly_net"),
  existingObligations: money("existing_obligations"),
  recomputedEligibleAmount: money("recomputed_eligible_amount"),
  dueDiligenceNotes: text("due_diligence_notes").notNull(),
  createdAt: createdAt(),
}, (t) => [index("hr_verifications_app_idx").on(t.applicationId)]);

/**
 * Bursary review (the "Bursary information" and "Bursar" sections of the paper form): loan history,
 * the take-home pay test and confirmation that funds are available, before final approval.
 */
export const bursaryReviews = pgTable("bursary_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  reviewerId: uuid("reviewer_id").notNull().references(() => users.id),
  decision: varchar("decision", { length: 20 }).notNull(), // "cleared" | "declined" | "returned"
  lastLoanDate: date("last_loan_date"),
  lastLoanRepaidDate: date("last_loan_repaid_date"),
  /** Basic plus medical, from the payslip. */
  monthlyGross: money("monthly_gross"),
  /** Net pay from the payslip: basic + medical − tax − pension − NHF. */
  monthlyNet: money("monthly_net"),
  monthlyDeduction: money("monthly_deduction"),
  /** All monthly deductions after this loan (payslip deductions, guarantees and this instalment). */
  takeHomeAfter: money("take_home_after"),
  /** takeHomeAfter as a percentage of net pay. */
  takeHomePercent: numeric("take_home_percent", { precision: 6, scale: 2 }),
  /** Whether takeHomeAfter is within the deduction limit. */
  takeHomeTestPassed: boolean("take_home_test_passed"),
  fundsAvailable: boolean("funds_available").notNull().default(false),
  comments: text("comments").notNull(),
  createdAt: createdAt(),
}, (t) => [index("bursary_reviews_app_idx").on(t.applicationId)]);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  level: integer("level").notNull(),
  approverId: uuid("approver_id").notNull().references(() => users.id),
  decision: approvalDecisionEnum("decision").notNull(),
  approvedAmount: money("approved_amount"),
  approvedTenorMonths: integer("approved_tenor_months"),
  comments: text("comments").notNull(),
  createdAt: createdAt(),
}, (t) => [index("approvals_app_idx").on(t.applicationId)]);

export const workflowTransitions = pgTable("workflow_transitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  action: varchar("action", { length: 50 }).notNull(),
  fromStatus: applicationStatusEnum("from_status"),
  toStatus: applicationStatusEnum("to_status").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  actorRole: varchar("actor_role", { length: 50 }).notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
}, (t) => [index("wf_transitions_app_idx").on(t.applicationId, t.createdAt)]);

export const applicationMessages = pgTable("application_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  authorId: uuid("author_id").notNull().references(() => users.id),
  /** "clarification" (guarantor ↔ applicant), "correction" (HR/approver → applicant), "internal" (staff only). */
  kind: varchar("kind", { length: 20 }).notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
}, (t) => [index("app_messages_app_idx").on(t.applicationId)]);

/* ───────────────────────────── Loan accounts ───────────────────────────── */

export const loanAccounts = pgTable("loan_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountNumber: varchar("account_number", { length: 30 }).notNull().unique(),
  applicationId: uuid("application_id").notNull().unique().references(() => loanApplications.id),
  borrowerId: uuid("borrower_id").notNull().references(() => users.id),
  productId: uuid("product_id").notNull().references(() => loanProducts.id),
  policyVersionId: uuid("policy_version_id").notNull().references(() => policyVersions.id),
  status: loanStatusEnum("status").notNull().default("pending_disbursement"),
  principal: money("principal").notNull(),
  interestMethod: varchar("interest_method", { length: 20 }).notNull(),
  annualInterestRate: rate("annual_interest_rate").notNull(),
  tenorMonths: integer("tenor_months").notNull(),
  /** Months between instalments (1 monthly, 2 bi-monthly, 3 quarterly); `monthlyInstalment` is per period. */
  repaymentPeriodMonths: integer("repayment_period_months").notNull().default(1),
  totalInterest: money("total_interest").notNull(),
  totalFees: money("total_fees").notNull().default("0"),
  totalRepayable: money("total_repayable").notNull(),
  monthlyInstalment: money("monthly_instalment").notNull(),
  /** Cached balances: always recomputed from ledger_entries inside the posting transaction. */
  principalOutstanding: money("principal_outstanding").notNull().default("0"),
  interestOutstanding: money("interest_outstanding").notNull().default("0"),
  overpaymentBalance: money("overpayment_balance").notNull().default("0"),
  totalRepaid: money("total_repaid").notNull().default("0"),
  daysPastDue: integer("days_past_due").notNull().default(0),
  approvedById: uuid("approved_by_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
  firstDueDate: date("first_due_date"),
  maturityDate: date("maturity_date"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  /**
   * When the Payroll Officer confirmed the first salary deduction. From then on each instalment is
   * recorded as deducted on its due date, without the borrower reporting it.
   */
  deductionsConfirmedAt: timestamp("deductions_confirmed_at", { withTimezone: true }),
  deductionsConfirmedBy: uuid("deductions_confirmed_by").references(() => users.id),
  rowVersion: integer("row_version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("loan_accounts_borrower_idx").on(t.borrowerId),
  index("loan_accounts_status_idx").on(t.status),
  check("loan_principal_positive", sql`${t.principal} > 0`),
]);

export const loanAgreements = pgTable("loan_agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  type: agreementTypeEnum("type").notNull(),
  partyUserId: uuid("party_user_id").notNull().references(() => users.id),
  termsDocumentId: uuid("terms_document_id").references(() => termsDocuments.id),
  version: integer("version").notNull().default(1),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  documentId: uuid("document_id").references(() => documents.id),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const disbursements = pgTable("disbursements", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  status: disbursementStatusEnum("status").notNull().default("pending_confirmation"),
  approvedAmount: money("approved_amount").notNull(),
  feesDeducted: money("fees_deducted").notNull().default("0"),
  amountDisbursed: money("amount_disbursed").notNull(),
  paymentDate: date("payment_date").notNull(),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  transactionReference: varchar("transaction_reference", { length: 100 }).notNull(),
  beneficiaryName: varchar("beneficiary_name", { length: 200 }).notNull(),
  beneficiaryBank: varchar("beneficiary_bank", { length: 120 }),
  beneficiaryAccountLast4: varchar("beneficiary_account_last4", { length: 4 }),
  evidenceDocumentId: uuid("evidence_document_id").references(() => documents.id),
  notes: text("notes"),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  transactionId: uuid("transaction_id").references(() => financialTransactions.id),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("disbursements_reference_uq").on(t.transactionReference),
  uniqueIndex("disbursements_one_live_uq").on(t.loanAccountId).where(sql`${t.status} <> 'rejected'`),
]);

export const repaymentSchedules = pgTable("repayment_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  version: integer("version").notNull(),
  isCurrent: boolean("is_current").notNull().default(true),
  reason: varchar("reason", { length: 50 }).notNull(), // "origination" | "restructure"
  basePrincipal: money("base_principal").notNull(),
  /**
   * Highest ledger_entries.id for this loan when the schedule was created. Only ledger movements
   * after the watermark are allocated to this schedule's instalments (restructures start fresh).
   */
  ledgerWatermark: integer("ledger_watermark").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("schedule_loan_version_uq").on(t.loanAccountId, t.version),
  uniqueIndex("schedule_one_current_uq").on(t.loanAccountId).where(sql`${t.isCurrent} = true`),
]);

export const scheduleInstalments = pgTable("schedule_instalments", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleId: uuid("schedule_id").notNull().references(() => repaymentSchedules.id),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  sequence: integer("sequence").notNull(),
  dueDate: date("due_date").notNull(),
  principalDue: money("principal_due").notNull(),
  interestDue: money("interest_due").notNull(),
  totalDue: money("total_due").notNull(),
  principalPaid: money("principal_paid").notNull().default("0"),
  interestPaid: money("interest_paid").notNull().default("0"),
  openingBalance: money("opening_balance").notNull(),
  closingBalance: money("closing_balance").notNull(),
  status: instalmentStatusEnum("status").notNull().default("pending"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("instalments_schedule_seq_uq").on(t.scheduleId, t.sequence),
  index("instalments_loan_due_idx").on(t.loanAccountId, t.dueDate),
]);

/* ───────────────────────── Financial transactions & ledger ───────────────────────── */

export const financialTransactions = pgTable("financial_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The loan's own reference: one reference for the whole loan cycle. Rows are told apart by id, type and date. */
  reference: varchar("reference", { length: 40 }).notNull(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  type: txnTypeEnum("type").notNull(),
  status: txnStatusEnum("status").notNull(),
  amount: money("amount").notNull(),
  valueDate: date("value_date").notNull(),
  narration: text("narration").notNull(),
  /** Bank / payroll reference: unique per type to block duplicate postings of the same real-world payment. */
  externalReference: varchar("external_reference", { length: 100 }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  reversesTransactionId: uuid("reverses_transaction_id"),
  /** Proposed ledger lines while pending approval (maker-checker); materialised into ledger_entries on posting. */
  proposedEntries: jsonb("proposed_entries"),
  makerId: uuid("maker_id").notNull().references(() => users.id),
  checkerId: uuid("checker_id").references(() => users.id),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("txn_loan_idx").on(t.loanAccountId, t.valueDate),
  index("txn_reference_idx").on(t.reference),
  uniqueIndex("txn_external_ref_uq").on(t.type, t.externalReference).where(sql`${t.externalReference} is not null and ${t.status} <> 'rejected'`),
  uniqueIndex("txn_single_reversal_uq").on(t.reversesTransactionId).where(sql`${t.reversesTransactionId} is not null and ${t.status} <> 'rejected'`),
  check("txn_amount_positive", sql`${t.amount} > 0`),
]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  transactionId: uuid("transaction_id").notNull().references(() => financialTransactions.id),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  account: ledgerAccountEnum("account").notNull(),
  direction: entryDirectionEnum("direction").notNull(),
  amount: money("amount").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("ledger_loan_account_idx").on(t.loanAccountId, t.account),
  index("ledger_txn_idx").on(t.transactionId),
  check("ledger_amount_positive", sql`${t.amount} > 0`),
]);

export const repaymentClaims = pgTable("repayment_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  claimedBy: uuid("claimed_by").notNull().references(() => users.id),
  amount: money("amount").notNull(),
  deductionMonth: date("deduction_month").notNull(),
  channel: paymentMethodEnum("channel").notNull().default("payroll"),
  payerReference: varchar("payer_reference", { length: 100 }),
  evidenceDocumentId: uuid("evidence_document_id").references(() => documents.id),
  note: text("note"),
  status: claimStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewComment: text("review_comment"),
  transactionId: uuid("transaction_id").references(() => financialTransactions.id),
  createdAt: createdAt(),
}, (t) => [
  index("claims_loan_idx").on(t.loanAccountId),
  uniqueIndex("claims_one_pending_per_month_uq").on(t.loanAccountId, t.deductionMonth).where(sql`${t.status} = 'pending'`),
  check("claims_amount_positive", sql`${t.amount} > 0`),
]);

/** The money set aside for staff loans in a year, set by the Head of Account. Loans paid out that year draw on it. */
export const fundPools = pgTable("fund_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  year: integer("year").notNull().unique(),
  amount: money("amount").notNull(),
  note: text("note"),
  setBy: uuid("set_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check("fund_pools_amount_not_negative", sql`${t.amount} >= 0`)]);

/**
 * A borrower repaying the whole balance early by bank transfer: the amount quoted on the day, their
 * payment receipt, and the Payroll Manager's decision. Only the full balance can be repaid early.
 */
export const earlyRepayments = pgTable("early_repayments", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  /** The settlement quote the borrower paid against. */
  quoteDate: date("quote_date").notNull(),
  amount: money("amount").notNull(),
  principal: money("principal").notNull(),
  interest: money("interest").notNull(),
  interestSaved: money("interest_saved").notNull().default("0"),
  payerReference: varchar("payer_reference", { length: 100 }),
  receiptDocumentId: uuid("receipt_document_id").notNull().references(() => documents.id),
  status: claimStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewComment: text("review_comment"),
  transactionId: uuid("transaction_id").references(() => financialTransactions.id),
  createdAt: createdAt(),
}, (t) => [
  index("early_repayments_loan_idx").on(t.loanAccountId),
  uniqueIndex("early_repayments_one_pending_uq").on(t.loanAccountId).where(sql`${t.status} = 'pending'`),
  check("early_repayments_amount_positive", sql`${t.amount} > 0`),
]);

export const restructureRequests = pgTable("restructure_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanAccountId: uuid("loan_account_id").notNull().references(() => loanAccounts.id),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  proposedTenorMonths: integer("proposed_tenor_months").notNull(),
  reason: text("reason").notNull(),
  status: restructureStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewComment: text("review_comment"),
  newScheduleId: uuid("new_schedule_id").references(() => repaymentSchedules.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("restructure_one_pending_uq").on(t.loanAccountId).where(sql`${t.status} = 'pending'`)]);

/* ───────────────────────────── Documents ───────────────────────────── */

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: varchar("category", { length: 50 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  storageKey: varchar("storage_key", { length: 300 }).notNull().unique(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  applicationId: uuid("application_id").references(() => loanApplications.id),
  loanAccountId: uuid("loan_account_id").references(() => loanAccounts.id),
  applicationGuarantorId: uuid("application_guarantor_id").references(() => applicationGuarantors.id),
  requirementCode: varchar("requirement_code", { length: 50 }),
  version: integer("version").notNull().default(1),
  supersedesId: uuid("supersedes_id"),
  isSystemGenerated: boolean("is_system_generated").notNull().default(false),
  uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  index("documents_app_idx").on(t.applicationId),
  index("documents_loan_idx").on(t.loanAccountId),
  index("documents_owner_idx").on(t.ownerUserId),
]);

/** A payslip a staff member uploaded, with what was read from it. Never changed once stored. */
export const staffPayslips = pgTable("staff_payslips", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  /** Pay month, "YYYY-MM". */
  period: varchar("period", { length: 7 }),
  /** The payslip as read (see lib/finance/payslip.ts). */
  data: jsonb("data").$type<import("@/lib/finance/payslip").Payslip>().notNull(),
  createdAt: createdAt(),
}, (t) => [index("staff_payslips_user_idx").on(t.userId)]);

export const documentAccessLogs = pgTable("document_access_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  action: varchar("action", { length: 20 }).notNull(), // upload | download | view | denied
  ipAddress: varchar("ip_address", { length: 64 }),
  createdAt: createdAt(),
});

/* ───────────────────────────── Notifications ───────────────────────────── */

export const notificationTemplates = pgTable("notification_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 60 }).notNull().unique(),
  name: varchar("name", { length: 150 }).notNull(),
  subject: varchar("subject", { length: 250 }).notNull(),
  body: text("body").notNull(),
  sendEmail: boolean("send_email").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  templateCode: varchar("template_code", { length: 60 }).notNull(),
  title: varchar("title", { length: 250 }).notNull(),
  body: text("body").notNull(),
  link: varchar("link", { length: 300 }),
  /** Prevents duplicate in-app notifications for the same event (reminders, status changes). */
  dedupeKey: varchar("dedupe_key", { length: 160 }).unique(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)]);

export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  notificationId: uuid("notification_id").references(() => notifications.id),
  toAddress: varchar("to_address", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 250 }).notNull(),
  body: text("body").notNull(),
  status: emailStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  dedupeKey: varchar("dedupe_key", { length: 120 }).unique(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("email_outbox_status_idx").on(t.status)]);

/* ───────────────────────── Configuration & audit ───────────────────────── */

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  isSensitive: boolean("is_sensitive").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

/** Append-only. UPDATE/DELETE blocked by trigger. */
export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: uuid("actor_id").references(() => users.id),
  action: varchar("action", { length: 80 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 64 }),
  summary: text("summary"),
  before: jsonb("before"),
  after: jsonb("after"),
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
}, (t) => [
  index("audit_entity_idx").on(t.entityType, t.entityId),
  index("audit_actor_idx").on(t.actorId, t.createdAt),
  index("audit_created_idx").on(t.createdAt),
]);

/** Monotonic per-prefix counters for human-readable references (LMS-YYMMDD-NNN, one daily sequence for every record type). */
export const referenceCounters = pgTable("reference_counters", {
  prefix: varchar("prefix", { length: 20 }).primaryKey(),
  value: integer("value").notNull().default(0),
});

/** Persistent rate-limit buckets (works across instances, unlike in-memory counters). */
export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 200 }).primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
});

/** Logos uploaded by administrators. When absent, the bundled files in public/branding are used. */
export const brandAssets = pgTable("brand_assets", {
  variant: varchar("variant", { length: 30 }).primaryKey(),
  mimeType: varchar("mime_type", { length: 60 }).notNull(),
  dataBase64: text("data_base64").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

/**
 * Register of every PDF the system issues (agreements, advices, receipts, statements, letters,
 * report exports). The SHA-256 of the exact bytes lets staff verify a document presented to them.
 */
export const issuedDocuments = pgTable("issued_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The loan's reference for loan documents (one reference per loan cycle); reports get their own. */
  reference: varchar("reference", { length: 40 }).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }),
  entityId: varchar("entity_id", { length: 64 }),
  loanAccountId: uuid("loan_account_id").references(() => loanAccounts.id),
  subjectUserId: uuid("subject_user_id").references(() => users.id),
  issuedBy: uuid("issued_by").references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  index("issued_documents_sha_idx").on(t.sha256),
  index("issued_documents_loan_idx").on(t.loanAccountId),
  index("issued_documents_reference_idx").on(t.reference),
]);

/** Published system versions with their release notes, shown to all staff under "Recent updates". */
export const releases = pgTable("releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: varchar("version", { length: 20 }).notNull().unique(),
  title: varchar("title", { length: 120 }).notNull(),
  notes: text("notes").notNull(),
  publishedBy: uuid("published_by").references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});
