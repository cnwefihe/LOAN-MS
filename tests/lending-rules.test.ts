/**
 * Institutional lending rules: one loan at a time (no top-ups), one guarantee at a time, and a
 * guarantor's possible liability counted against their own borrowing limit.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-rules-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures, FIXTURE_USERS, fixturePayslip } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft, submitApplication, computeEligibilityFor } from "@/server/services/applications";
import { recordSamplePayslip } from "@/server/services/payslips";
import { respondToGuarantee } from "@/server/services/guarantors";
import { getActivePolicy } from "@/server/services/policies";
import { storeDocument } from "@/server/services/documents";
import { updateSettingsGroup } from "@/server/services/admin";
import { dec } from "@/lib/finance/money";

let db: Database;
let productId: string;
let before = { capacity: "", afford: "" };
const ids: Record<string, string> = {};
const A = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const PDF = Buffer.from("%PDF-1.4\n%%EOF");

async function apply(key: string, guarantorEmails: string[], amount = "600000") {
  const a = await A(key);
  const d = await saveDraft(db, a, { productId, requestedAmount: amount, tenorMonths: 12, purpose: "Lending rules test application", guarantorEmails });
  await storeDocument(db, a, { buffer: PDF, fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: d.id, requirementCode: "PAYSLIP" });
  await submitApplication(db, a, d.id, { termsAccepted: true });
  return d.id;
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

describe("lending rules", () => {
  let first = "";

  it("Tunde's eligibility before he guarantees anyone, for comparison", async () => {
    const policy = (await getActivePolicy(db, productId))!.params;
    const r = await computeEligibilityFor(db, ids.guarantor1, policy, {});
    expect(r.guaranteeCommitment).toBe("0.00");
    before = { capacity: r.availableMonthlyCapacity, afford: r.maxByAffordability };
  });

  it("a guarantor may guarantee one loan at a time, checked at nomination and at acceptance", async () => {
    first = await apply("applicant", ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"]);
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, first));
    for (const g of gs) {
      const [u] = await db.select().from(s.users).where(eq(s.users.id, g.guarantorId));
      await respondToGuarantee(db, (await loadActor(db, g.guarantorId, { ip: null, userAgent: null }))!, g.id, { decision: "accept", typedName: u.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    }
    await expect(apply("hrdirector", ["tunde.bello.dev@example.edu.ng", "kunle.adeyemi.dev@example.edu.ng"])).rejects.toThrow(/already guaranteeing another loan/);
  });

  it("anyone with a loan or application in progress cannot apply again (no top-ups)", async () => {
    const policy = (await getActivePolicy(db, productId))!.params;
    const r = await computeEligibilityFor(db, ids.applicant, policy, { requestedAmount: "100000", tenorMonths: 12 });
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/one loan at a time/);
    await expect(apply("applicant", ["kunle.adeyemi.dev@example.edu.ng", "funmi.adebayo.dev@example.edu.ng"])).rejects.toThrow(/one loan at a time/);
  });

  it("when a guarantor applies, what they could be called to repay reduces what they can borrow", async () => {
    const policy = (await getActivePolicy(db, productId))!.params;
    const r = await computeEligibilityFor(db, ids.guarantor1, policy, {});
    expect(dec(r.guaranteeCommitment).greaterThan(0)).toBe(true);
    // Monthly headroom drops by exactly the commitment, and so does the amount affordability allows.
    expect(dec(before.capacity).minus(r.availableMonthlyCapacity).toFixed(2)).toBe(dec(r.guaranteeCommitment).toFixed(2));
    expect(dec(r.maxByAffordability).lessThan(before.afford)).toBe(true);
  });

  it("administrators can switch the guarantee rule off; it then has no effect", async () => {
    const admin = await A("admin");
    await updateSettingsGroup(db, admin, "Lending rules", { "lending.countGuarantees": false }, true);
    const policy = (await getActivePolicy(db, productId))!.params;
    const r = await computeEligibilityFor(db, ids.guarantor1, policy, {});
    expect(r.guaranteeCommitment).toBe("0.00");
    expect(r.availableMonthlyCapacity).toBe(before.capacity);
    await updateSettingsGroup(db, admin, "Lending rules", { "lending.countGuarantees": true }, true);
  });

  it("works from the latest payslip on the server, so a new payslip with a cooperative loan lowers the limit", async () => {
    const policy = (await getActivePolicy(db, productId))!.params;
    const free = await computeEligibilityFor(db, ids.guarantor2, policy, {});
    // Ngozi's sample payslip: basic 380,000 + medical 26,600 − tax 57,000 − pension 30,400 = 319,200 net; 33.3% = 106,293.60.
    expect(free.payslip?.netPay).toBe("319200.00");
    expect(free.monthlyDeductionCap).toBe("106293.60");
    const f = FIXTURE_USERS.find((u) => u.key === "guarantor2")!;
    const newer = fixturePayslip(f);
    newer.deductions.push({ label: "Cooperative Contribution", amount: "40000.00" });
    await recordSamplePayslip(db, await A("guarantor2"), ids.guarantor2, newer);
    const owing = await computeEligibilityFor(db, ids.guarantor2, policy, {});
    expect(owing.payslip?.committed).toBe("40000.00");
    expect(dec(free.availableMonthlyCapacity).minus(owing.availableMonthlyCapacity).toFixed(2)).toBe("40000.00");
    expect(dec(owing.maxEligibleAmount).lessThan(free.maxEligibleAmount)).toBe(true);
  });
});
