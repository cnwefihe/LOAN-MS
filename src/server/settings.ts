import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db";
import { systemSettings } from "@/db/schema";
import { contrastRatio } from "@/lib/colour";
import type { Permission } from "@/lib/auth/permissions";

export const SETTING_GROUPS = ["Organisation and branding", "Documents", "Workflow", "Workflow wording", "Lending rules", "School accounts", "Reminders", "Automation", "Financial controls", "Security", "Notifications", "Data retention", "Privacy", "Announcements"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** The permission that lets someone change each group of settings. */
export const GROUP_PERMISSION: Record<SettingGroup, Permission> = {
  "Organisation and branding": "admin.branding.manage", Documents: "admin.branding.manage",
  "Lending rules": "settings.lending", "Financial controls": "settings.lending",
  "School accounts": "settings.school_accounts", Security: "settings.security",
  Workflow: "admin.settings.manage", "Workflow wording": "admin.settings.manage", Reminders: "admin.settings.manage", Automation: "admin.settings.manage",
  Notifications: "admin.settings.manage", "Data retention": "admin.settings.manage", Privacy: "admin.settings.manage", Announcements: "admin.settings.manage",
};
/** Anyone with one of these may open Settings, and sees the groups their permissions allow. */
export const SETTINGS_PERMISSIONS: Permission[] = ["admin.settings.manage", "settings.lending", "settings.school_accounts", "settings.security"];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max);
/** An email address, or empty until an administrator enters it (kept in the database, never in the code). */
const optionalEmail = z.union([z.literal(""), z.string().trim().email()]);
const DAY = 1440;
/** Stored in minutes; entered as minutes, hours or days. */
const reminderMinutes = (maxDays: number) => z.number().int().min(1).max(maxDays * DAY);
export const MFA_SCOPES = ["everyone", "staff", "off"] as const;
const IDLE_CHOICES = ["5", "10", "30", "60"] as const;
const idleMinutes = z.number().int().refine((m) => (IDLE_CHOICES as readonly string[]).includes(String(m)), "Choose one of the listed times.");
const VERIFY_TRIES = ["3", "5", "10"] as const;
const VERIFY_LOCK = ["5", "10", "15", "30", "60"] as const;
const SUPPORT_MAX = ["1", "2", "3", "5", "10"] as const;
const SIGNIN_MAX = ["10", "20", "30", "50"] as const;
const SIGNIN_WINDOW = ["5", "15", "30", "60"] as const;
const CODE_TRIES = ["3", "5", "8", "10"] as const;
const SESSIONS_USERS = ["1", "2", "3", "5"] as const;
const SESSIONS_ADMIN = ["1", "2", "3", "5", "10"] as const;
const SUPPORT_WINDOW = ["30", "60", "120", "360", "1440"] as const;
const VERIFY_VALID = ["0", "5", "10", "15", "30", "60"] as const;
const oneOf = (list: readonly string[]) => z.number().int().refine((n) => list.includes(String(n)), "Choose one of the listed values.");
const hexColour = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #2E3A6E.")
  .refine((c) => contrastRatio(c, "#ffffff") >= 4.5, "This colour is too light: white text on it would fall below the WCAG AA contrast ratio of 4.5:1.");

/**
 * Typed registry of runtime-configurable system settings. Values live in system_settings and are
 * edited through the admin console; these definitions supply validation, defaults and grouping.
 */
export const SETTINGS = {
  "org.institutionName": { group: "Organisation and branding", schema: text(120), default: "Pan-Atlantic University", sensitive: false, label: "Institution name" },
  "org.shortName": { group: "Organisation and branding", schema: text(20), default: "PAU", sensitive: false, label: "Short name" },
  "org.systemName": { group: "Organisation and branding", schema: text(80), default: "Loan Management System", sensitive: false, label: "System name" },
  "branding.primaryColour": { group: "Organisation and branding", schema: hexColour, default: "#2E3A6E", sensitive: false, label: "Primary colour" },
  "org.supportEmail": { group: "Organisation and branding", schema: optionalEmail, default: "", sensitive: false, label: "Bursary email" },
  "org.hrEmail": { group: "Organisation and branding", schema: optionalEmail, default: "", sensitive: false, label: "Human Resources email" },
  "org.hrPhone": { group: "Organisation and branding", schema: optionalText(40), default: "", sensitive: false, label: "Human Resources telephone (optional)" },
  "org.ictEmail": { group: "Organisation and branding", schema: optionalEmail, default: "", sensitive: false, label: "ICT support email" },
  "org.supportPhone": { group: "Organisation and branding", schema: optionalText(40), default: "", sensitive: false, label: "Bursary telephone (optional)" },
  "org.address": { group: "Organisation and branding", schema: optionalText(200), default: "Km 52 Lekki-Epe Expressway, Ibeju-Lekki, Lagos, Nigeria", sensitive: false, label: "Postal address" },

  "documents.confidentialMarking": { group: "Documents", schema: text(30), default: "CONFIDENTIAL", sensitive: false, label: "Security marking" },
  "documents.maxUploadMb": { group: "Documents", schema: z.number().int().min(1).max(25), default: 10, sensitive: false, label: "Maximum upload size in MB (up to 25)" },
  "documents.footerNotice": { group: "Documents", schema: text(160), default: "{institution}. Authorised User Only.", sensitive: false, label: "Footer notice" },
  "documents.watermarkEnabled": { group: "Documents", schema: z.boolean(), default: true, sensitive: false, label: "Print the security marking as a diagonal watermark on every PDF page" },

  "wording.stageHr": { group: "Workflow wording", schema: text(40), default: "Human Resources verification", sensitive: false, label: "Human Resources stage" },
  "wording.stageBursary": { group: "Workflow wording", schema: text(40), default: "Bursary review", sensitive: false, label: "Bursary stage" },
  "wording.stageHod": { group: "Workflow wording", schema: text(40), default: "HOD approval", sensitive: false, label: "HOD stage" },
  "wording.stageLineManager": { group: "Workflow wording", schema: text(40), default: "Line Manager approval", sensitive: false, label: "Line Manager stage" },
  "wording.stageHrDirector": { group: "Workflow wording", schema: text(40), default: "HR Director approval", sensitive: false, label: "HR Director stage" },
  "wording.stageApproval": { group: "Workflow wording", schema: text(40), default: "Bursar's final approval", sensitive: false, label: "Bursar stage" },
  "wording.sectionBursary": { group: "Workflow wording", schema: text(30), default: "Bursary", sensitive: false, label: "Bursary menu heading" },
  "wording.sectionApproval": { group: "Workflow wording", schema: text(30), default: "Approvals", sensitive: false, label: "Approvals menu heading" },
  "workflow.allowApproverReturnToHr": { group: "Workflow", schema: z.boolean(), default: true, sensitive: false, label: "Approvers may refer applications back to Human Resources" },
  "lending.oneLoanAtATime": { group: "Lending rules", schema: z.boolean(), default: true, sensitive: true, label: "Staff may hold one loan at a time" },
  "lending.oneGuaranteeAtATime": { group: "Lending rules", schema: z.boolean(), default: false, sensitive: true, label: "Staff may guarantee one loan at a time" },
  "lending.countGuarantees": { group: "Lending rules", schema: z.boolean(), default: true, sensitive: true, label: "Count what a guarantor could be called to repay against their deduction limit" },
  "reminders.enabled": { group: "Reminders", schema: z.boolean(), default: true, sensitive: false, label: "Send reminders for work left waiting" },
  "reminders.hrMinutes": { group: "Reminders", schema: reminderMinutes(60), default: DAY, sensitive: false, label: "Remind Human Resources after" },
  "reminders.accountsMinutes": { group: "Reminders", schema: reminderMinutes(60), default: DAY, sensitive: false, label: "Remind the Bursary and Accounts Payable after" },
  "reminders.approvalMinutes": { group: "Reminders", schema: reminderMinutes(60), default: DAY, sensitive: false, label: "Remind approvers after" },
  "reminders.guarantorMinutes": { group: "Reminders", schema: reminderMinutes(60), default: DAY, sensitive: false, label: "Remind guarantors after" },
  "reminders.repeatMinutes": { group: "Reminders", schema: reminderMinutes(30), default: DAY, sensitive: false, label: "Repeat each reminder every" },
  "reminders.escalateMinutes": { group: "Reminders", schema: reminderMinutes(90), default: 5 * DAY, sensitive: false, label: "Alert Super Administrators after" },

  "automation.checkEveryMinutes": { group: "Automation", schema: z.number().int().min(60).max(8 * 7 * DAY), default: 7 * DAY, sensitive: false, label: "Run the automatic loan check every (hourly at most)" },

  "finance.makerChecker.repayment": { group: "Financial controls", schema: z.boolean(), default: false, sensitive: true, label: "Repayment confirmations" },
  "finance.makerChecker.adjustment": { group: "Financial controls", schema: z.boolean(), default: true, sensitive: true, label: "Waivers, adjustments and refunds" },
  "finance.makerChecker.reversal": { group: "Financial controls", schema: z.boolean(), default: true, sensitive: true, label: "Reversals" },

  "security.idleMinutesUsers": { group: "Security", schema: idleMinutes, default: 10, sensitive: true, label: "Sign out: everyone else after no activity for", options: IDLE_CHOICES },
  "security.idleMinutesAdmin": { group: "Security", schema: idleMinutes, default: 10, sensitive: true, label: "Sign out: Super Administrators after no activity for", options: IDLE_CHOICES },
  "security.maxSessionsUsers": { group: "Security", schema: oneOf(SESSIONS_USERS), default: 1, sensitive: true, label: "Sessions at the same time: everyone else (signing in again ends the oldest)", options: SESSIONS_USERS, optionLabels: { 1: "1 session", 2: "2 sessions", 3: "3 sessions", 5: "5 sessions" } },
  "security.maxSessionsAdmin": { group: "Security", schema: oneOf(SESSIONS_ADMIN), default: 3, sensitive: true, label: "Sessions at the same time: Super Administrators", options: SESSIONS_ADMIN, optionLabels: { 1: "1 session", 2: "2 sessions", 3: "3 sessions", 5: "5 sessions", 10: "10 sessions" } },
  "security.verifyMaxFailures": { group: "Security", schema: oneOf(VERIFY_TRIES), default: 5, sensitive: true, label: "Security check (slider): failed attempts before the device is locked", options: VERIFY_TRIES, optionLabels: { 3: "3 attempts", 5: "5 attempts", 10: "10 attempts" } },
  "security.verifyLockMinutes": { group: "Security", schema: oneOf(VERIFY_LOCK), default: 10, sensitive: true, label: "Security check (slider): lock the device for", options: VERIFY_LOCK },
  "security.verifyValidMinutes": { group: "Security", schema: oneOf(VERIFY_VALID), default: 10, sensitive: true, label: "Security check (slider): after passing, do not ask again for", options: VERIFY_VALID, optionLabels: { 0: "None: ask at every sign-in" } },
  "security.signInAttemptsMax": { group: "Security", schema: oneOf(SIGNIN_MAX), default: 30, sensitive: true, label: "Sign-in with Microsoft: attempts allowed from one network address", options: SIGNIN_MAX, optionLabels: { 10: "10 attempts", 20: "20 attempts", 30: "30 attempts", 50: "50 attempts" } },
  "security.signInAttemptsWindowMinutes": { group: "Security", schema: oneOf(SIGNIN_WINDOW), default: 5, sensitive: true, label: "Sign-in with Microsoft: counted over", options: SIGNIN_WINDOW, optionLabels: { 5: "5 minutes", 15: "15 minutes", 30: "30 minutes", 60: "1 hour" } },
  "security.codeFailuresMax": { group: "Security", schema: oneOf(CODE_TRIES), default: 5, sensitive: true, label: "Two-step codes: wrong codes allowed before the account is locked", options: CODE_TRIES, optionLabels: { 3: "3 wrong codes", 5: "5 wrong codes", 8: "8 wrong codes", 10: "10 wrong codes" } },
  "security.codeLockMinutes": { group: "Security", schema: oneOf(VERIFY_LOCK), default: 15, sensitive: true, label: "Two-step codes: lock the account for", options: VERIFY_LOCK },
  "security.mfaScope": { group: "Security", schema: z.enum(MFA_SCOPES), default: "everyone", sensitive: true, label: "Two-step codes: required for", options: MFA_SCOPES, optionLabels: { everyone: "Everyone", staff: "Approval and payment roles", off: "No one" } },
  "security.registerIdleMinutes": { group: "Security", schema: oneOf(VERIFY_LOCK), default: 10, sensitive: true, label: "Register: close after no activity for", options: VERIFY_LOCK },
  "security.supportRequestsMax": { group: "Security", schema: oneOf(SUPPORT_MAX), default: 3, sensitive: true, label: "ICT support: requests allowed from each person or device", options: SUPPORT_MAX, optionLabels: { 1: "1 request", 2: "2 requests", 3: "3 requests", 5: "5 requests", 10: "10 requests" } },
  "security.supportRequestsWindowMinutes": { group: "Security", schema: oneOf(SUPPORT_WINDOW), default: 60, sensitive: true, label: "ICT support: counted over", options: SUPPORT_WINDOW, optionLabels: { 30: "30 minutes", 60: "1 hour", 120: "2 hours", 360: "6 hours", 1440: "1 day" } },

  "notifications.emailEnabled": { group: "Notifications", schema: z.boolean(), default: true, sensitive: false, label: "Send email notifications" },
  "notifications.emailSignature": { group: "Notifications", schema: text(200), default: "Bursary, Pan-Atlantic University", sensitive: false, label: "Email sign-off" },

  "retention.readNotificationsMonths": { group: "Data retention", schema: z.number().int().min(3).max(120), default: 24, sensitive: false, label: "Delete read notifications after (months)" },
  "retention.sessionDays": { group: "Data retention", schema: z.number().int().min(7).max(730), default: 90, sensitive: false, label: "Delete session records after (days)" },
  "retention.emailOutboxMonths": { group: "Data retention", schema: z.number().int().min(1).max(120), default: 12, sensitive: false, label: "Delete sent email copies after (months)" },

  "privacy.dpoEmail": { group: "Privacy", schema: optionalEmail, default: "", sensitive: false, label: "Data Protection Officer contact" },

  "system.announcement": { group: "Announcements", schema: optionalText(400), default: "", sensitive: false, label: "Announcement" },
  "system.announcementTone": { group: "Announcements", schema: z.enum(["info", "warning"]), default: "info", sensitive: false, label: "Style", options: ["info", "warning"] },
} as const satisfies Record<string, { group: SettingGroup; schema: z.ZodType; default: unknown; sensitive: boolean; label: string; options?: readonly string[]; optionLabels?: Record<string, string> }>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

function coerce<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const def = SETTINGS[key];
  const parsed = def.schema.safeParse(raw);
  return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: Executor, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, key));
  return row ? coerce(key, row.value) : (SETTINGS[key].default as SettingValue<K>);
}

/** How long this person may stay inactive: administrators have their own limit, everyone else shares one. */
export function idleMinutesFor(db: Executor, roles: readonly string[]) {
  return getSetting(db, roles.includes("SUPER_ADMIN") ? "security.idleMinutesAdmin" : "security.idleMinutesUsers");
}

/** Reads several settings in one query. */
export async function getSettings<K extends SettingKey>(db: Executor, keys: readonly K[]): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings).where(inArray(systemSettings.key, [...keys]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(keys.map((k) => [k, byKey.has(k) ? coerce(k, byKey.get(k)) : SETTINGS[k].default])) as { [P in K]: SettingValue<P> };
}
