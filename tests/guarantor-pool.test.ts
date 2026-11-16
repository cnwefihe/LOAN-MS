/**
 * Guarantors chosen from the list of the managerial cadre kept by an administrator: applicants see names
 * only, the email is used to send the request, and anyone not on the list is refused. The Bereavement Loan
 * needs no guarantors.
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
import { guarantorChoices, importGuarantors, saveGuarantorEntry } from "@/server/services/guarantor-pool";
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

describe("list of eligible guarantors", () => {
  it("an administrator adds people one at a time or many at once; other staff cannot", async () => {
    const admin = await actor("admin");
    await saveGuarantorEntry(db, admin, { name: "Grace  Okon", email: "Grace.Okon@example.edu.ng" });
    await expect(saveGuarantorEntry(db, admin, { name: "Grace Okon", email: "grace.okon@example.edu.ng" })).rejects.toThrow(/already on the list/);
    await expect(saveGuarantorEntry(db, admin, { name: "Someone Else", email: "someone@gmail.com" })).rejects.toThrow(/not a work email/);
    await expect(saveGuarantorEntry(db, await actor("applicant"), { name: "Ada Obi", email: "ada.obi@example.edu.ng" })).rejects.toThrow();

    const r = await importGuarantors(db, admin, "Name, Email\nAda Obi, ada.obi@example.edu.ng\nGrace Okon-Bassey\tgrace.okon@example.edu.ng\nno email here");
    expect(r).toMatchObject({ added: 1, updated: 1 });
    expect(r.skipped).toEqual(["no email here"]);
    const [grace] = await db.select().from(s.guarantorPool).where(eq(s.guarantorPool.email, "grace.okon@example.edu.ng"));
    expect(grace).toMatchObject({ name: "Grace Okon-Bassey", cadre: "Managerial", isActive: true });
  });

  it("applicants see names only, never their own, and not those marked unavailable", async () => {
    const admin = await actor("admin");
    const [ada] = await db.select().from(s.guarantorPool).where(eq(s.guarantorPool.email, "ada.obi@example.edu.ng"));
    await saveGuarantorEntry(db, admin, { id: ada.id, name: ada.name, email: ada.email, isActive: false });
    const me = await actor("applicant");
    const choices = await guarantorChoices(db, me.email);
    expect(choices.every((c) => Object.keys(c).sort().join() === "id,name")).toBe(true);
    expect(choices.some((c) => c.name === "Adaeze Okafor")).toBe(false);
    expect(choices.some((c) => c.name === "Ada Obi")).toBe(false);
    expect(choices.some((c) => c.name === "Tunde Bello")).toBe(true);
  });

  it("the names chosen are turned into the guarantors' emails; the same person twice or someone off the list is refused", async () => {
    const a = await actor("applicant");
    const pick = async (email: string) => (await db.select().from(s.guarantorPool).where(eq(s.guarantorPool.email, email)))[0].id;
    const tunde = await pick("tunde.bello.dev@example.edu.ng");
    const ngozi = await pick("ngozi.eze.dev@example.edu.ng");
    const base = { productId, requestedAmount: "300000", tenorMonths: 12, purpose: "School fees for my children", guarantorEmails: [] };
    await expect(saveDraft(db, a, { ...base, guarantorIds: [tunde, tunde] })).rejects.toThrow(/two different guarantors/);
    await expect(saveDraft(db, a, { ...base, guarantorIds: [tunde, "not-an-id"] })).rejects.toThrow(/from the list/);
    const d = await saveDraft(db, a, { ...base, guarantorIds: [tunde, ngozi] });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, d.id));
    expect(app.nominatedGuarantors).toEqual(["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"]);

    // Someone typed in directly, not on the list, is refused at submission.
    const off = await saveDraft(db, a, { ...base, applicationId: d.id, guarantorEmails: ["tunde.bello.dev@example.edu.ng", "stranger.dev@example.edu.ng"] });
    await storeDocument(db, a, { buffer: PDF, fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: off.id, requirementCode: "PAYSLIP" });
    await expect(submitApplication(db, a, off.id, { termsAccepted: true })).rejects.toThrow(/chosen from the list/);
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
    expect(policy.body).toMatch(/managerial cadre/);
    expect(policy.body).toMatch(/30% of their net monthly salary/);
  });
});
