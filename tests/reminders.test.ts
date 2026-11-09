/** Reminders for waiting work, with timings set by administrators. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-reminders-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { canAccessDocument, storeDocument } from "@/server/services/documents";
import { remindWaitingWork } from "@/server/services/reminders";
import { updateSettingsGroup } from "@/server/services/admin";
import { addDays, todayLagos } from "@/lib/finance/dates";
import { durationText, splitMinutes, waitedText } from "@/lib/duration";

let db: Database;
const ids: Record<string, string> = {};
const A = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const count = async (template: string, userId: string) => (await db.select().from(s.notifications).where(eq(s.notifications.templateCode, template))).filter((n) => n.userId === userId).length;

beforeAll(async () => {
  db = await getDb();
  let productId = "";
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
  const a = await A("applicant");
  const d = await saveDraft(db, a, { productId, requestedAmount: "500000", tenorMonths: 12, purpose: "Reminder test application", guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"] });
  await storeDocument(db, a, { buffer: Buffer.from("%PDF-1.4\n%%EOF"), fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: d.id, requirementCode: "PAYSLIP" });
  await submitApplication(db, a, d.id, { termsAccepted: true });
  for (const g of await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, d.id))) {
    const [u] = await db.select().from(s.users).where(eq(s.users.id, g.guarantorId));
    await respondToGuarantee(db, (await loadActor(db, g.guarantorId, { ip: null, userAgent: null }))!, g.id, { decision: "accept", typedName: u.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
  }
});

describe("guarantors and the borrower's documents", () => {
  it("a guarantor cannot open the borrower's payslip", async () => {
    const g = await A("guarantor1");
    const docs = await db.select().from(s.documents).where(eq(s.documents.requirementCode, "PAYSLIP"));
    const onApplication = docs.filter((d) => d.applicationId);
    expect(onApplication.length).toBeGreaterThan(0);
    for (const d of onApplication) expect(await canAccessDocument(db, g, d)).toBe(false);
  });
});

describe("work reminders", () => {
  it("nothing is sent within the first 24 hours", async () => {
    expect((await remindWaitingWork(db, todayLagos())).reminders).toBe(0);
  });

  it("HR is reminded once 24 hours have passed, once per repeat period", async () => {
    const day3 = addDays(todayLagos(), 1);
    expect((await remindWaitingWork(db, day3)).reminders).toBe(1);
    expect(await count("reminder.work", ids.hradmin)).toBe(1);
    expect(await count("reminder.work", ids.applicant)).toBe(0); // never to the applicant
    await remindWaitingWork(db, day3);
    expect(await count("reminder.work", ids.hradmin)).toBe(1); // no duplicate the same period
    expect(await count("reminder.escalation", ids.admin)).toBe(0);
  });

  it("Super Administrators are alerted once the alert threshold passes", async () => {
    await remindWaitingWork(db, addDays(todayLagos(), 6));
    expect(await count("reminder.work", ids.hradmin)).toBe(2);
    expect(await count("reminder.escalation", ids.admin)).toBe(1);
    const [n] = (await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "reminder.escalation"))).filter((x) => x.userId === ids.admin);
    expect(n.title).toMatch(/^Overdue: Application LMS-\d{6}-\d{3} waiting \d+ days?$/);
  });

  it("administrators change the timings, or turn reminders off", async () => {
    const admin = await A("admin");
    await updateSettingsGroup(db, admin, "Reminders", { "reminders.hrMinutes": 10 * 1440, "reminders.escalateMinutes": 20 * 1440 }, false);
    expect((await remindWaitingWork(db, addDays(todayLagos(), 8))).reminders).toBe(0);
    await updateSettingsGroup(db, admin, "Reminders", { "reminders.hrMinutes": 2 * 1440, "reminders.enabled": false }, false);
    expect((await remindWaitingWork(db, addDays(todayLagos(), 8))).reminders).toBe(0);
  });

  it("timings can be set in minutes", async () => {
    const admin = await A("admin");
    await updateSettingsGroup(db, admin, "Reminders", { "reminders.hrMinutes": 30, "reminders.repeatMinutes": 60, "reminders.enabled": true }, false);
    // Workflow history cannot be edited, so move the clock instead.
    const [{ last }] = await db.select({ last: sql<Date>`max(${s.workflowTransitions.createdAt})` }).from(s.workflowTransitions);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(last).getTime() + 25 * 60_000);
      expect((await remindWaitingWork(db, todayLagos())).reminders).toBe(0);
      vi.setSystemTime(new Date(last).getTime() + 45 * 60_000);
      expect((await remindWaitingWork(db, todayLagos())).reminders).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows timings in the right unit", () => {
    expect(splitMinutes(1440)).toEqual({ amount: 1, unit: 1440 });
    expect(splitMinutes(120)).toEqual({ amount: 2, unit: 60 });
    expect(splitMinutes(90)).toEqual({ amount: 90, unit: 1 });
    expect([durationText(30), durationText(60), durationText(7200)]).toEqual(["30 minutes", "1 hour", "5 days"]);
    expect([waitedText(45), waitedText(90), waitedText(2000)]).toEqual(["45 minutes", "1 hour", "1 day"]);
  });
});
