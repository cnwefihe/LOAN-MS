import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  roles, permissions, rolePermissions, notificationTemplates, systemSettings, termsDocuments, users, userRoles, staffProfiles,
  schools, departments, staffCategories, loanProducts, policyVersions, documentRequirements,
  fundPools,
} from "@/db/schema";
import { PERMISSIONS, ROLE_DEFINITIONS, RETIRED_ROLE_CODES, SPLIT_FROM, type RoleCode } from "@/lib/auth/permissions";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { SUGGESTED_PRODUCTS } from "@/lib/finance/suggested-products";
import { encryptString } from "@/lib/security/crypto";
import { DEFAULT_TEMPLATES } from "./notification-templates";
import { SETTINGS } from "./settings";
import { ensureInitialRelease } from "./services/releases";
import { latestPayslip, recordSamplePayslip } from "./services/payslips";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import { todayLagos } from "@/lib/finance/dates";
import type { Actor } from "./actor";

const PLACEHOLDER = "[PLACEHOLDER: to be replaced by the Bursary and Legal Office with the approved text before go-live]";

/** Reference data every environment needs. Idempotent. */
/** Earlier default role names, renamed only while an administrator has not changed them. */
const FORMER_ROLE_NAMES: Partial<Record<RoleCode, string[]>> = { ACCOUNTS_OFFICER: ["Bursary Officer", "Accounts Officer"], ACCOUNTS_ADMIN: ["Accounts Administrator"] };

/** Removes roles the workflow no longer uses. HR Officers become HR Administrators, the one HR role. */
async function retireRoles(db: Executor) {
  const old = await db.select().from(roles).where(inArray(roles.code, [...RETIRED_ROLE_CODES]));
  if (!old.length) return;
  const [hrAdmin] = await db.select().from(roles).where(eq(roles.code, "HR_ADMIN"));
  const hrOfficer = old.find((r) => r.code === "HR_OFFICER");
  if (hrOfficer && hrAdmin) {
    const holders = await db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, hrOfficer.id));
    if (holders.length) await db.insert(userRoles).values(holders.map((h) => ({ userId: h.userId, roleId: hrAdmin.id }))).onConflictDoNothing();
  }
  await db.delete(userRoles).where(inArray(userRoles.roleId, old.map((r) => r.id)));
  await db.delete(roles).where(inArray(roles.id, old.map((r) => r.id)));
}

export async function seedBase(db: Executor) {
  const knownPermissions = new Set((await db.select({ code: permissions.code }).from(permissions)).map((p) => p.code));
  for (const [code, def] of Object.entries(PERMISSIONS)) {
    await db.insert(permissions).values({ code, description: def.description, category: def.category }).onConflictDoUpdate({ target: permissions.code, set: { description: def.description, category: def.category } });
  }
  const permRows = await db.select().from(permissions);
  for (const [code, def] of Object.entries(ROLE_DEFINITIONS)) {
    const [existing] = await db.select().from(roles).where(eq(roles.code, code));
    if (existing) {
      // Never overwrite admin-edited grants; only add permissions introduced since the last seed.
      const added = permRows.filter((p) => knownPermissions.size > 0 && !knownPermissions.has(p.code) && (def.permissions as string[]).includes(p.code));
      if (added.length) await db.insert(rolePermissions).values(added.map((p) => ({ roleId: existing.id, permissionId: p.id }))).onConflictDoNothing();
      if (FORMER_ROLE_NAMES[code as RoleCode]?.includes(existing.name)) await db.update(roles).set({ name: def.name, description: def.description }).where(eq(roles.id, existing.id));
      continue;
    }
    const [role] = await db.insert(roles).values({ code, name: def.name, description: def.description }).returning();
    const ids = permRows.filter((p) => (def.permissions as string[]).includes(p.code)).map((p) => ({ roleId: role.id, permissionId: p.id }));
    if (ids.length) await db.insert(rolePermissions).values(ids).onConflictDoNothing();
  }
  // A permission split out of a broader one goes, when it first appears, to every role holding the broader one.
  if (knownPermissions.size > 0) {
    for (const [code, from] of Object.entries(SPLIT_FROM)) {
      if (knownPermissions.has(code)) continue;
      const target = permRows.find((p) => p.code === code), source = permRows.find((p) => p.code === from);
      if (!target || !source) continue;
      const holders = await db.select({ roleId: rolePermissions.roleId }).from(rolePermissions).where(eq(rolePermissions.permissionId, source.id));
      if (holders.length) await db.insert(rolePermissions).values(holders.map((h) => ({ roleId: h.roleId, permissionId: target.id }))).onConflictDoNothing();
    }
  }
  await retireRoles(db);
  // Permissions an administrator has turned on or off are kept as they are; deployments do not change them.
  for (const t of DEFAULT_TEMPLATES) {
    await db.insert(notificationTemplates).values(t).onConflictDoNothing();
  }
  // The limit now carries its own unit, such as "5 days" or "30 minutes".
  await db.update(notificationTemplates).set({ body: sql`replace(${notificationTemplates.body}, '{{limit}}-day limit', '{{limit}} limit')` }).where(eq(notificationTemplates.code, "reminder.escalation"));
  // Reminder timings moved from days to minutes.
  for (const [from, to] of [["reminders.hrDays", "reminders.hrMinutes"], ["reminders.approvalDays", "reminders.approvalMinutes"], ["reminders.accountsDays", "reminders.accountsMinutes"], ["reminders.escalateDays", "reminders.escalateMinutes"], ["reminders.repeatDays", "reminders.repeatMinutes"], ["workflow.guarantorResponseDays", "reminders.guarantorMinutes"]] as const) {
    const [old] = await db.select().from(systemSettings).where(eq(systemSettings.key, from));
    if (!old) continue;
    await db.insert(systemSettings).values({ key: to, value: (Number(old.value) * 1440) as never, description: SETTINGS[to].label, isSensitive: false }).onConflictDoNothing();
    await db.delete(systemSettings).where(eq(systemSettings.key, from));
  }
  for (const [key, def] of Object.entries(SETTINGS)) {
    await db.insert(systemSettings).values({ key, value: def.default as never, description: def.label, isSensitive: def.sensitive }).onConflictDoNothing();
  }
  // Replaced by separate limits for users and administrators.
  await db.delete(systemSettings).where(inArray(systemSettings.key, ["security.sessionIdleMinutes", "security.sessionAbsoluteHours", "policy.requireSecondApprover", "security.mfaRequired"]));
  await seedSuggestedProducts(db);
  await seedSampleOrganisation(db);
  await ensureInitialRelease(db);
  // Loan terms and the guarantor agreement; the privacy notice is published separately.
  const [anyTerms] = await db.select({ id: termsDocuments.id }).from(termsDocuments).where(inArray(termsDocuments.kind, ["loan_terms", "guarantor_agreement"])).limit(1);
  if (!anyTerms) {
    await db.insert(termsDocuments).values([
      {
        kind: "loan_terms", version: 1, isActive: true, title: "Staff Loan Terms and Conditions",
        body: `${PLACEHOLDER}\n\n1. The borrower authorises the University to deduct the agreed monthly instalment from salary until the loan and interest are fully repaid.\n2. If employment ends before full repayment, the outstanding balance becomes due immediately and may be recovered from final entitlements.\n3. The borrower confirms that all information supplied is true and complete, and consents to its processing for the purpose of this loan in line with the Nigeria Data Protection Act 2023.\n4. Repayments are only credited when confirmed by the Bursary.`,
      },
      {
        kind: "guarantor_agreement", version: 1, isActive: true, title: "Guarantor Agreement",
        body: `${PLACEHOLDER}\n\nI agree to serve as guarantor for the loan application submitted by the applicant named in this record. I am fully aware of the terms and conditions of this loan and acknowledge that I will be held financially responsible if the borrower fails to meet his or her repayment obligations. I declare that the information I have provided is accurate and complete to the best of my knowledge, and I permit the University to contact me directly should the applicant default.\n\n1. I guarantee repayment of the amount stated below if the borrower fails to repay.\n2. If the loan is in default, I authorise the University to recover the guaranteed amount, or the outstanding share of it, from my salary or entitlements.\n3. My obligation ends when the loan is fully settled and closed.\n4. I consent to the processing of my personal data for this guarantee in line with the Nigeria Data Protection Act 2023.`,
      },
    ]);
  }
}

/** Adds a document requirement unless one with the same code already exists for that scope. */
async function ensureRequirement(db: Executor, productId: string | null, r: { code: string; label: string; appliesTo: "applicant" | "guarantor"; isRequired: boolean }) {
  const [existing] = await db.select({ id: documentRequirements.id }).from(documentRequirements)
    .where(and(eq(documentRequirements.code, r.code), productId ? eq(documentRequirements.productId, productId) : isNull(documentRequirements.productId)));
  if (!existing) await db.insert(documentRequirements).values({ productId, ...r });
}

/**
 * The starting catalogue (see lib/finance/suggested-products.ts), created once, open to staff, with the
 * values configured before go-live. Administrators change them through a new policy version (maker-checker),
 * or close a product. Products that already exist (by code) are never touched again, so changes survive releases.
 */
export async function seedSuggestedProducts(db: Executor) {
  await ensureRequirement(db, null, { code: "PAYSLIP", label: "Most recent payslip", appliesTo: "applicant", isRequired: true });
  for (const sp of SUGGESTED_PRODUCTS) {
    const [exists] = await db.select({ id: loanProducts.id }).from(loanProducts).where(eq(loanProducts.code, sp.code));
    if (exists) continue;
    const [product] = await db.insert(loanProducts).values({ code: sp.code, name: sp.name, description: sp.description, isActive: true }).returning();
    const now = new Date();
    await db.insert(policyVersions).values({ productId: product.id, version: 1, status: "active", parameters: sp.policy, approvedAt: now, effectiveFrom: now, changeNote: STARTING_VALUES });
    for (const d of sp.documents) await ensureRequirement(db, product.id, d);
  }
}

/** Change note on each product's first version. */
export const STARTING_VALUES = "Starting values configured before go-live. To change them, start a new version.";

/**
 * Sample organisation structure, created once on a new installation (when there are no schools yet) so
 * departments and staff categories are ready to edit under Administration > Organisation. Never re-added.
 */
export async function seedSampleOrganisation(db: Executor) {
  const [any] = await db.select({ id: schools.id }).from(schools).limit(1);
  if (any) return;
  const school = async (code: string, name: string) => (await db.insert(schools).values({ code, name }).onConflictDoNothing().returning())[0];
  const ids: Record<string, string> = {
    SST: (await school("SST", "School of Science and Technology")).id,
    SMC: (await school("SMC", "School of Media and Communication")).id,
    SMSS: (await school("SMSS", "School of Management and Social Sciences")).id,
    ADMIN: (await school("ADMIN", "Central Administration")).id,
  };
  // Academic departments are approved by their Head of Department; administrative units by their Line Manager.
  const rows: [string, string, string, "hod" | "line_manager"][] = [
    ["SST-CS", "Computer Science", "SST", "hod"], ["MCM", "Mass Communication", "SMC", "hod"], ["SMSS-ECO", "Economics", "SMSS", "hod"],
    ["HR", "Human Resources", "ADMIN", "line_manager"], ["REG", "Registry", "ADMIN", "line_manager"], ["BUR", "Bursary", "ADMIN", "line_manager"], ["ICT", "ICT Services", "ADMIN", "line_manager"],
  ];
  for (const [code, name, sc, approverTitle] of rows) await db.insert(departments).values({ code, name, schoolId: ids[sc], approverTitle }).onConflictDoNothing();
  for (const [code, name] of [["ACAD", "Academic staff"], ["SNR-ADMIN", "Senior administrative staff"], ["JNR-ADMIN", "Junior administrative staff"]]) {
    await db.insert(staffCategories).values({ code, name }).onConflictDoNothing();
  }
}

/* ───────────────────────── Development fixtures ───────────────────────── */

/**
 * One test account per role in the workflow (two guarantors, as every loan needs two), plus a second
 * applicant who has no loan, for trying an application from the start.
 */
export const FIXTURE_USERS: { key: string; email: string; name: string; label: string; roles: RoleCode[]; status: "confirmed" | "probation"; years: number; dept: string; designation: string; staffNumber: string; basic?: string; bank?: boolean }[] = [
  { key: "applicant", email: "adaeze.okafor.dev@example.edu.ng", name: "Adaeze Okafor", label: "Applicant", roles: ["APPLICANT"], status: "confirmed", years: 5, dept: "MCM", designation: "Lecturer II", staffNumber: "DEV-1001", basic: "500000", bank: true },
  { key: "freshapplicant", email: "seun.bakare.dev@example.edu.ng", name: "Seun Bakare", label: "Applicant (no loan yet)", roles: ["APPLICANT"], status: "confirmed", years: 4, dept: "SMSS-ECO", designation: "Lecturer II", staffNumber: "DEV-1005", bank: true },
  { key: "guarantor1", email: "tunde.bello.dev@example.edu.ng", name: "Tunde Bello", label: "Guarantor", roles: ["APPLICANT"], status: "confirmed", years: 8, dept: "SST-CS", designation: "Senior Lecturer", staffNumber: "DEV-1002", basic: "420000" },
  { key: "guarantor2", email: "ngozi.eze.dev@example.edu.ng", name: "Ngozi Eze", label: "Guarantor", roles: ["APPLICANT"], status: "confirmed", years: 6, dept: "SMSS-ECO", designation: "Lecturer I", staffNumber: "DEV-1003", basic: "380000" },
  { key: "hradmin", email: "kunle.adeyemi.dev@example.edu.ng", name: "Kunle Adeyemi", label: "HR Administrator", roles: ["APPLICANT", "HR_ADMIN"], status: "confirmed", years: 10, dept: "HR", designation: "HR Administrator", staffNumber: "DEV-2002" },
  { key: "bursary", email: "chioma.nnaji.dev@example.edu.ng", name: "Chioma Nnaji", label: "Bursary Officer", roles: ["APPLICANT", "BURSARY_OFFICER"], status: "confirmed", years: 6, dept: "BUR", designation: "Bursary Officer", staffNumber: "DEV-4003" },
  { key: "hod", email: "funmi.adebayo.dev@example.edu.ng", name: "Funmilayo Adebayo", label: "HOD", roles: ["APPLICANT"], status: "confirmed", years: 12, dept: "MCM", designation: "Head of Department", staffNumber: "DEV-3001" },
  { key: "linemanager", email: "yetunde.ajayi.dev@example.edu.ng", name: "Yetunde Ajayi", label: "Line Manager", roles: ["APPLICANT"], status: "confirmed", years: 11, dept: "REG", designation: "Line Manager, Administration", staffNumber: "DEV-3002" },
  { key: "hrdirector", email: "halima.musa.dev@example.edu.ng", name: "Halima Musa", label: "HR Director", roles: ["APPLICANT", "HR_DIRECTOR"], status: "confirmed", years: 14, dept: "HR", designation: "Director, Human Resources", staffNumber: "DEV-2001" },
  { key: "accadmin", email: "bisi.lawal.dev@example.edu.ng", name: "Bisi Lawal", label: "Bursar", roles: ["APPLICANT", "ACCOUNTS_ADMIN"], status: "confirmed", years: 9, dept: "BUR", designation: "Bursar", staffNumber: "DEV-4002" },
  { key: "accounts", email: "chidi.obi.dev@example.edu.ng", name: "Chidi Obi", label: "Accounts Payable Officer", roles: ["APPLICANT", "ACCOUNTS_OFFICER"], status: "confirmed", years: 3, dept: "BUR", designation: "Accounts Payable Officer", staffNumber: "DEV-4001" },
  { key: "payroll", email: "amaka.eze.dev@example.edu.ng", name: "Amaka Eze", label: "Payroll Officer", roles: ["APPLICANT", "PAYROLL_OFFICER"], status: "confirmed", years: 4, dept: "BUR", designation: "Payroll Officer", staffNumber: "DEV-4004" },
  { key: "payrollmanager", email: "folake.ojo.dev@example.edu.ng", name: "Folake Ojo", label: "Payroll Manager", roles: ["APPLICANT", "PAYROLL_MANAGER"], status: "confirmed", years: 10, dept: "BUR", designation: "Payroll Manager", staffNumber: "DEV-4005" },
  { key: "headofaccount", email: "ibrahim.sani.dev@example.edu.ng", name: "Ibrahim Sani", label: "Head of Account", roles: ["APPLICANT", "HEAD_OF_ACCOUNT"], status: "confirmed", years: 15, dept: "BUR", designation: "Head of Account", staffNumber: "DEV-4006" },
  { key: "admin", email: "emeka.nwosu.dev@example.edu.ng", name: "Emeka Nwosu", label: "Super Administrator", roles: ["APPLICANT", "SUPER_ADMIN"], status: "confirmed", years: 7, dept: "ICT", designation: "Systems Administrator", staffNumber: "DEV-5001" },
];

/** Pay grade for a fixture account, as it appears on its sample payslip. */
export const fixtureGrade = (f: { designation: string; years: number }) => `${f.designation} Step ${Math.min(f.years, 9)}`;

/**
 * Sample payslip for a fixture account (made-up figures). Basic defaults to ₦350,000; medical is 7% of basic,
 * pension 8% and tax 15% (sample figures only). The first applicant also has a cafeteria deduction and the first
 * guarantor a cooperative loan, so those rules can be seen in use.
 */
export function fixturePayslip(f: (typeof FIXTURE_USERS)[number], period = todayLagos().slice(0, 7)) {
  const basic = Number(f.basic ?? "350000");
  const r = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
  return samplePayslip({
    name: f.name, code: f.staffNumber, grade: fixtureGrade(f), period,
    basic: r(basic), medical: r(basic * 0.07), tax: r(basic * 0.15), pension: r(basic * 0.08),
    deductions: f.key === "applicant" ? [{ label: "Cafeteria Meal Deduction", amount: "6500" }]
      : f.key === "guarantor1" ? [{ label: "Cooperative Loan Repayment", amount: "20000" }, { label: "Cafeteria Meal Deduction", amount: "4200" }] : [],
  });
}

/** Who approves for each sample department: the HOD for academic departments, the Line Manager for units. */
export const FIXTURE_HEADS: Record<string, string> = { MCM: "hod", "SST-CS": "hod", "SMSS-ECO": "hod", HR: "linemanager", BUR: "linemanager", ICT: "linemanager", REG: "linemanager" };
export const LINE_MANAGED_UNITS = ["HR", "BUR", "ICT", "REG"];

/**
 * Clearly-marked DEVELOPMENT fixtures: sample organisation units, one loan product with the
 * placeholder policy, and fictional staff accounts usable through the dev fixture login, with sample payslips.
 * Refuses to run in production.
 */
export async function seedFixtures(db: Executor) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed development fixtures in production.");
  // The organisation itself comes from the base seed (seedSampleOrganisation); fixtures only add people.
  await seedSampleOrganisation(db);
  const deptByCode = new Map((await db.select().from(departments)).map((d) => [d.code, d]));
  const [acad] = await db.select().from(staffCategories).where(eq(staffCategories.code, "ACAD"));
  const allRoles = await db.select().from(roles);

  const ids: Record<string, string> = {};
  for (const f of FIXTURE_USERS) {
    let [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${f.email}`);
    if (!u) [u] = await db.insert(users).values({ email: f.email, displayName: f.name, isDevFixture: true }).returning();
    ids[f.key] = u.id;
    for (const rc of f.roles) {
      const role = allRoles.find((r) => r.code === rc)!;
      await db.insert(userRoles).values({ userId: u.id, roleId: role.id }).onConflictDoNothing();
    }
    const dept = deptByCode.get(f.dept)!;
    const employed = new Date();
    employed.setUTCFullYear(employed.getUTCFullYear() - f.years);
    employed.setUTCMonth(employed.getUTCMonth() - 2);
    const profile = {
      userId: u.id, staffNumber: f.staffNumber, departmentId: dept.id, schoolId: dept.schoolId, categoryId: acad.id, designation: f.designation, payGrade: fixtureGrade(f), payslipDetailsConfirmedAt: new Date(),
      employmentStatus: f.status, employmentDate: employed.toISOString().slice(0, 10),
      phone: "+234 803 000 0000", residentialAddress: "Pan-Atlantic University staff quarters, Ibeju-Lekki, Lagos",
      ...(f.basic ? { monthlyBasic: `${f.basic}.00`, salarySource: "hr_verified" as const, salaryVerifiedAt: new Date() } : {}),
      ...(f.bank ? { bankName: "Development Test Bank", bankAccountNumberEnc: encryptString("0123456789"), bankAccountLast4: "6789", bankAccountName: f.name } : {}),
    };
    await db.insert(staffProfiles).values(profile).onConflictDoNothing();
  }
  // A sample payslip for each account, so eligibility can be worked out straight away.
  const seeder: Actor = { userId: ids.admin, email: "system@dev", displayName: "Development seed", roles: [], permissions: new Set() };
  for (const f of FIXTURE_USERS) {
    if (!(await latestPayslip(db, ids[f.key]))) await recordSamplePayslip(db, seeder, ids[f.key], fixturePayslip(f));
  }
  for (const [code, key] of Object.entries(FIXTURE_HEADS)) {
    await db.update(departments).set({ headUserId: ids[key], approverTitle: LINE_MANAGED_UNITS.includes(code) ? "line_manager" : "hod" }).where(and(eq(departments.code, code), isNull(departments.headUserId)));
  }

  let [product] = await db.select().from(loanProducts).where(eq(loanProducts.code, "STAFF-PL"));
  if (!product) {
    [product] = await db.insert(loanProducts).values({ code: "STAFF-PL", name: "General Staff Loan (test)", description: "Test product for development. Policy values are placeholders.", createdBy: ids.admin }).returning();
    await db.insert(policyVersions).values({ productId: product.id, version: 1, status: "active", parameters: { ...DEFAULT_POLICY, allowRestructuring: true }, changeNote: "Development fixture policy (placeholder values)", createdBy: ids.admin, submittedBy: ids.admin, approvedBy: ids.admin, approvedAt: new Date(), effectiveFrom: new Date() });
    await ensureRequirement(db, null, { code: "PAYSLIP", label: "Most recent payslip", appliesTo: "applicant", isRequired: true });
  }
  // A fund pool for the years tests and walkthroughs pay loans in (fixture figures only).
  const year = Number(todayLagos().slice(0, 4));
  for (const sc of await db.select({ id: schools.id }).from(schools))
    for (const y of [year - 1, year, year + 1]) await db.insert(fundPools).values({ year: y, schoolId: sc.id, amount: "500000000.00", note: "Development fixture", setBy: ids.headofaccount }).onConflictDoNothing();
  return { ids, productId: product.id };
}
