import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db";
import { systemSettings } from "@/db/schema";
import { contrastRatio } from "@/lib/colour";

export const SETTING_GROUPS = ["Organisation and branding", "Documents", "Workflow", "Workflow wording", "Lending rules", "Early repayment", "Reminders", "Financial controls", "Security", "Notifications", "Data retention", "Privacy", "Announcements"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max);
const DAY = 1440;
/** Stored in minutes; entered as minutes, hours or days. */
const reminderMinutes = (maxDays: number) => z.number().int().min(1).max(maxDays * DAY);
export const MFA_SCOPES = ["everyone", "staff", "off"] as const;
const IDLE_CHOICES = ["5", "10", "30", "60"] as const;
const idleMinutes = z.number().int().refine((m) => (IDLE_CHOICES as readonly string[]).includes(String(m)), "Choose one of the listed times.");
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
  "org.supportEmail": { group: "Organisation and branding", schema: z.string().email(), default: "bursary@example.edu.ng", sensitive: false, label: "Support email" },
  "org.hrEmail": { group: "Organisation and branding", schema: z.string().email(), default: "hr@example.edu.ng", sensitive: false, label: "Human Resources email" },
  "org.ictEmail": { group: "Organisation and branding", schema: z.string().email(), default: "staff.member@example.edu.ng", sensitive: false, label: "ICT support email" },
  "earlyRepayment.bankName": { group: "Early repayment", schema: z.string().trim().max(100), default: "", sensitive: false, label: "Bank for early repayments" },
  "earlyRepayment.accountName": { group: "Early repayment", schema: z.string().trim().max(150), default: "", sensitive: false, label: "Account name for early repayments" },
  "earlyRepayment.accountNumber": { group: "Early repayment", schema: z.string().trim().regex(/^(\d{10})?$/, "Enter the 10-digit account number"), default: "", sensitive: false, label: "Account number for early repayments" },
  "org.supportPhone": { group: "Organisation and branding", schema: optionalText(40), default: "", sensitive: false, label: "Support telephone (optional)" },
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

  "finance.makerChecker.repayment": { group: "Financial controls", schema: z.boolean(), default: false, sensitive: true, label: "Repayment confirmations" },
  "finance.makerChecker.adjustment": { group: "Financial controls", schema: z.boolean(), default: true, sensitive: true, label: "Waivers, adjustments and refunds" },
  "finance.makerChecker.reversal": { group: "Financial controls", schema: z.boolean(), default: true, sensitive: true, label: "Reversals" },

  "security.idleMinutesUsers": { group: "Security", schema: idleMinutes, default: 10, sensitive: true, label: "Sign out users after", options: IDLE_CHOICES },
  "security.idleMinutesAdmin": { group: "Security", schema: idleMinutes, default: 10, sensitive: true, label: "Sign out administrators after", options: IDLE_CHOICES },
  "security.mfaScope": { group: "Security", schema: z.enum(MFA_SCOPES), default: "everyone", sensitive: true, label: "Require two-step verification for", options: MFA_SCOPES, optionLabels: { everyone: "Everyone", staff: "Approval and payment roles", off: "No one" } },

  "notifications.emailEnabled": { group: "Notifications", schema: z.boolean(), default: true, sensitive: false, label: "Send email notifications" },
  "notifications.emailSignature": { group: "Notifications", schema: text(200), default: "Bursary, Pan-Atlantic University", sensitive: false, label: "Email sign-off" },

  "retention.readNotificationsMonths": { group: "Data retention", schema: z.number().int().min(3).max(120), default: 24, sensitive: false, label: "Delete read notifications after (months)" },
  "retention.sessionDays": { group: "Data retention", schema: z.number().int().min(7).max(730), default: 90, sensitive: false, label: "Delete session records after (days)" },
  "retention.emailOutboxMonths": { group: "Data retention", schema: z.number().int().min(1).max(120), default: 12, sensitive: false, label: "Delete sent email copies after (months)" },

  "privacy.dpoEmail": { group: "Privacy", schema: z.string().email(), default: "dpo@example.edu.ng", sensitive: false, label: "Data Protection Officer contact" },

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
