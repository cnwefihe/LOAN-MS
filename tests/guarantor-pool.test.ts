/**
 * Any active user may be chosen as a guarantor: applicants see names only, the email is used to send the
 * request, and the loan policy decides whether they qualify. The Bereavement Loan needs no guarantors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-gpool-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { storeDocument } from "@/server/services/documents";
import { guarantorChoices, guaranteeRequests } from "@/server/services/guarantor-pool";
import { getActivePolicy, getLoanPolicy } from "@/server/services/policies";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const PDF = Buffer.from("%PDF-1.4\n%%EOF");
let productId = "";

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    Object.assign(ids, r.ids);
    productId = r.productId;
  });
});

describe("guarantors", () => {
  it("any active user may be chosen; applicants see names only, never their own, and not deactivated users", async () => {
    const me = await actor("applicant");
    const choices = await guarantorChoices(db, me.email);
    const active = await db.select().from(s.users).where(eq(s.users.isActive, true));
    expect(choices).toHaveLength(active.length - 1);
    expect(choices.every((c) => Object.keys(c).sort().join() === "id,name")).toBe(true);
    expect(choices.some((c) => c.id === me.userId)).toBe(false);
    const [ngozi] = await db.select().from(s.users).where(eq(s.users.email, "ngozi.eze.dev@example.edu.ng"));
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, ngozi.id));
    expect((await guarantorChoices(db, me.email)).some((c) => c.id === ngozi.id)).toBe(false);
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, ngozi.id));
  });

  it("the names chosen are turned into the guarantors' emails; the same person twice or a deactivated user is refused", async () => {
    const a = await actor("applicant");
    const pick = async (email: string) => (await db.select().from(s.users).where(eq(s.users.email, email)))[0].id;
    const tunde = await pick("tunde.bello.dev@example.edu.ng");
    const ngozi = await pick("ngozi.eze.dev@example.edu.ng");
    const base = { productId, requestedAmount: "300000", tenorMonths: 12, purpose: "School fees for my children", guarantorEmails: [] };
    await expect(saveDraft(db, a, { ...base, guarantorIds: [tunde, tunde] })).rejects.toThrow(/two different guarantors/);
    await expect(saveDraft(db, a, { ...base, guarantorIds: [tunde, "not-an-id"] })).rejects.toThrow(/from the list/);
    const d = await saveDraft(db, a, { ...base, guarantorIds: [tunde, ngozi] });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, d.id));
    expect(app.nominatedGuarantors).toEqual(["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"]);

    // A guarantor deactivated after being chosen is refused at submission.
    await storeDocument(db, a, { buffer: PDF, fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: d.id, requirementCode: "PAYSLIP" });
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, ngozi));
    await expect(submitApplication(db, a, d.id, { termsAccepted: true })).rejects.toThrow(/can no longer be chosen/);
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, ngozi));
  });

  it("only an administrator sees who has been chosen as a guarantor", async () => {
    expect(Array.isArray(await guaranteeRequests(db, await actor("admin")))).toBe(true);
    await expect(guaranteeRequests(db, await actor("applicant"))).rejects.toThrow();
  });

  it("the Bereavement Loan is interest-free and needs no guarantors", async () => {
    const [b] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, "BEREAVEMENT"));
    const p = (await getActivePolicy(db, b.id))!.params;
    expect(p).toMatchObject({ requiredGuarantors: 0, interestMethod: "interest_free", annualInterestRate: 0 });
  });

  it("guarantors are checked at 30% of net pay and may stand for two loans; the policy text is there for staff", async () => {
    const p = (await getActivePolicy(db, productId))!.params;
    expect(p).toMatchObject({ guarantorMaxDeductionPercent: 30, maxGuaranteesPerGuarantor: 2, guarantorMinServiceMonths: 12 });
    const policy = await getLoanPolicy(db);
    expect(policy.body).toMatch(/Any staff member may be chosen as a guarantor/);
    expect(policy.body).toMatch(/30% of their net monthly salary/);
  });
});
