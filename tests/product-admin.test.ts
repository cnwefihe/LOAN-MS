/** Administrators edit, copy, discard and delete loan products and their policy versions. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-product-admin-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { createProduct, createDraftFrom, deleteProduct, discardDraft, updateDraft, updateProductDetails, listPolicyVersions } from "@/server/services/policies";

let db: Database;
const ids: Record<string, string> = {};
let usedProductId = "";
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    Object.assign(ids, r.ids);
    usedProductId = r.productId;
  });
});

describe("product administration", () => {
  it("renames a product and updates its description", async () => {
    const admin = await actor("admin");
    const p = await createProduct(db, admin, { code: "STAFF-CAR", name: "Car Loan", description: "" });
    await updateProductDetails(db, admin, p.id, { name: "Vehicle Loan", description: "For buying a car." });
    const [row] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.id, p.id));
    expect(row.name).toBe("Vehicle Loan");
    expect(row.description).toBe("For buying a car.");
    await expect(updateProductDetails(db, admin, p.id, { name: "X", description: "" })).rejects.toThrow(/3 to 150/);
  });

  it("starts a new draft from an earlier version, and discards drafts", async () => {
    const admin = await actor("admin");
    const p = await createProduct(db, admin, { code: "STAFF-HOME", name: "Home Loan" });
    const [v1] = await listPolicyVersions(db, p.id);
    await updateDraft(db, admin, v1.id, { ...(v1.parameters as object), annualInterestRate: 7, interestMethod: "flat" }, "Seven per cent");
    const v2 = await createDraftFrom(db, admin, p.id, v1.id);
    expect(v2.version).toBe(2);
    expect((v2.parameters as { annualInterestRate: number }).annualInterestRate).toBe(7);
    await discardDraft(db, admin, v2.id);
    expect((await listPolicyVersions(db, p.id)).map((v) => v.version)).toEqual([1]);
  });

  it("deletes an unused product, but never one with applications on record", async () => {
    const admin = await actor("admin");
    const p = await createProduct(db, admin, { code: "STAFF-TEMP", name: "Temporary Loan" });
    await deleteProduct(db, admin, p.id);
    expect(await db.select().from(s.loanProducts).where(eq(s.loanProducts.id, p.id))).toHaveLength(0);
    expect(await db.select().from(s.policyVersions).where(eq(s.policyVersions.productId, p.id))).toHaveLength(0);

    const applicant = await actor("applicant");
    await db.insert(s.loanApplications).values({ reference: "LMS-261102-901", applicantId: applicant.userId, productId: usedProductId, policyVersionId: (await listPolicyVersions(db, usedProductId))[0].id, requestedAmount: "100000", tenorMonths: 6, purpose: "Kept for the record", status: "draft", salarySnapshot: {}, quote: {} } as never);
    await expect(deleteProduct(db, admin, usedProductId)).rejects.toThrow(/cannot be deleted/);
    await expect(deleteProduct(db, await actor("hradmin"), usedProductId)).rejects.toThrow();
  });
});
