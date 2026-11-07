/** Default management, payroll posting, guarantor reminders and retention housekeeping on a real Postgres engine. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq, sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-svc-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee, guarantorExposure } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { storeDocument } from "@/server/services/documents";
import { recordDisbursement, runServicing, callOnGuarantors, proposeWriteOff, approvePendingTransaction, recordRepayment } from "@/server/services/loans";
import { proposeReversal } from "@/server/services/ledger";
import { postPayrollDeductions } from "@/server/services/payroll";
import { addMonths, addDays, todayLagos } from "@/lib/finance/dates";

let db: Database;
let productId: string;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const PDF = Buffer.from("%PDF-1.4\n%%EOF");

async function applyAndApprove(applicantKey: string, guarantorKeys: string[], amount: string) {
  const a = await actor(applicantKey);
  const draft = await saveDraft(db, a, { productId, requestedAmount: amount, tenorMonths: 12, purpose: "Servicing test application", guarantorEmails: await Promise.all(guarantorKeys.map(async (k) => (await actor(k)).email)) });
  await storeDocument(db, a, { buffer: PDF, fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: draft.id, requirementCode: "PAYSLIP" });
  await submitApplication(db, a, draft.id, { termsAccepted: true });
  return draft.id;
}

async function acceptAll(appId: string) {
  const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, appId));
  for (const g of gs) {
    const ga = (await loadActor(db, g.guarantorId))!;
    await respondToGuarantee(db, ga, g.id, { decision: "accept", typedName: ga.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
  }
}

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
});

describe("loan servicing & default management", () => {
  let loanId: string;

  it("sets up a disbursed loan", async () => {
    const appId = await applyAndApprove("applicant", ["guarantor1", "guarantor2"], "600000");
    await acceptAll(appId);
    const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, appId), eq(s.applicationGuarantors.status, "accepted")));
    await recordHrDecision(db, await actor("hradmin"), appId, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", notes: "Verified for servicing test.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })) });
    await reviewByBursary(db, await actor("bursary"), appId, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
    await decideApplication(db, await actor("hod"), appId, { decision: "approved", comments: "Supported by the department." });
    await decideApplication(db, await actor("hrdirector"), appId, { decision: "approved", comments: "Approved by the HR Director." });
    const { loan } = await decideApplication(db, await actor("accadmin"), appId, { decision: "approved", comments: "Approved for test." });
    loanId = loan!.id;
    await recordDisbursement(db, await actor("accounts"), loanId, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "SVC-FT-1", amountDisbursed: loan!.principal, idempotencyKey: "svc-1" });
  });

  it("posts payroll deductions idempotently by reference", async () => {
    const officer = await actor("bursary");
    const rows = [{ staffNumber: "DEV-1001", amount: "10000.00", reference: "PR-TEST-1", valueDate: todayLagos() }, { staffNumber: "NOPE", amount: "1.00", reference: "PR-TEST-2", valueDate: todayLagos() }];
    const first = await postPayrollDeductions(db, officer, rows, "test");
    expect(first).toMatchObject({ posted: 1, duplicates: 0 });
    expect(first.errors[0]).toMatch(/unknown staff number/);
    const again = await postPayrollDeductions(db, officer, rows, "test");
    expect(again).toMatchObject({ posted: 0, duplicates: 1 });
  });

  it("classifies default, calls on guarantors and records a guarantor recovery", async () => {
    const r = await runServicing(db, null, addMonths(todayLagos(), 6));
    expect(r.changes.join()).toMatch(/→ defaulted/);
    const n = await callOnGuarantors(db, await actor("bursary"), loanId, "Please contact the Bursary within 14 days.");
    expect(n).toBe(2);
    const called = await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "guarantor.called"));
    expect(called).toHaveLength(2);
    const t = await recordRepayment(db, await actor("bursary"), loanId, { amount: "20000", valueDate: todayLagos(), reference: "REC-G1", channel: "bank_transfer", idempotencyKey: "rec-g1", guarantorId: ids.guarantor1 });
    expect(t.narration).toMatch(/recovery from guarantor Tunde Bello/);
    await expect(recordRepayment(db, await actor("bursary"), loanId, { amount: "1", valueDate: todayLagos(), reference: "REC-X", channel: "bank_transfer", idempotencyKey: "rec-x", guarantorId: ids.hrdirector })).rejects.toThrow(/not an accepted guarantor/);
  });

  it("write-off needs checker approval, releases guarantors and can be reversed", async () => {
    await runServicing(db, null, addMonths(todayLagos(), 6)); // keep in default
    const wo = await proposeWriteOff(db, await actor("bursary"), loanId, "Approved by Bursar per default committee minute 12/2026");
    expect(wo.status).toBe("pending_approval");
    await expect(approvePendingTransaction(db, await actor("bursary"), wo.id)).rejects.toThrow(/not authorised|cannot approve/);
    await approvePendingTransaction(db, await actor("accadmin"), wo.id);
    let [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).toBe("written_off");
    expect((await guarantorExposure(db, ids.guarantor1)).total).toBe("0.00");

    const rev = await proposeReversal(db, await actor("bursary"), wo.id, "Recovery arrangement agreed; reinstating");
    await approvePendingTransaction(db, await actor("accadmin"), rev.id);
    [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).not.toBe("written_off");
    expect(Number(loan.principalOutstanding)).toBeGreaterThan(0);
  });
});

describe("guarantor reminders & housekeeping", () => {
  it("reminds unresponsive guarantors once per period", async () => {
    await applyAndApprove("guarantor1", ["hradmin", "hod"], "300000");
    const future = addDays(todayLagos(), 8);
    const r1 = await runServicing(db, null, future);
    expect(r1.guarantorReminders).toBe(2);
    const count = async () => (await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "guarantor.reminder"))).length;
    const before = await count();
    await runServicing(db, null, future);
    expect(await count()).toBe(before); // de-duplicated
  });

  it("purges only stale operational data", async () => {
    await db.insert(s.notifications).values({ userId: ids.applicant, templateCode: "test.old", title: "old", body: "old", readAt: new Date(), createdAt: new Date("2020-01-01") });
    await db.insert(s.sessions).values({ tokenHash: "x".repeat(64), userId: ids.applicant, authMethod: "dev_fixture", expiresAt: new Date("2020-01-02"), createdAt: new Date("2020-01-01") });
    // An orphaned (unregistered) file older than a day, simulating a rolled-back upload.
    const orphan = path.join(process.env.STORAGE_DIR!, "2020", "01", "orphan");
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, "ciphertext");
    fs.utimesSync(orphan, new Date("2020-01-01"), new Date("2020-01-01"));
    const registeredBefore = (await db.select().from(s.documents)).length;

    const r = await runServicing(db, null);
    expect(r.purged.notifications).toBeGreaterThanOrEqual(1);
    expect(r.purged.sessions).toBe(1);
    expect(r.purged.orphanedFiles).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    // Every registered document's file is still present and readable.
    const { readDocument } = await import("@/server/services/documents");
    const docs = await db.select().from(s.documents);
    expect(docs.length).toBe(registeredBefore);
    const accadmin = await actor("accadmin");
    for (const d of docs.slice(0, 3)) expect((await readDocument(db, accadmin, d.id)).data.length).toBeGreaterThan(0);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.ledgerEntries);
    expect(Number(n)).toBeGreaterThan(0); // financial records untouched
  });
});
