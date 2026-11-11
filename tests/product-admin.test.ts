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
import { createProduct, deleteProduct, updateProductDetails, listPolicyVersions, saveProductTerms, setProductActive, getActivePolicy, getPolicyVersion } from "@/server/services/policies";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";

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

  it("edits a product's terms and saves them, with no versions to manage; applications keep the terms they were made on", async () => {
    const admin = await actor("admin");
    const p = await createProduct(db, admin, { code: "STAFF-HOME", name: "Home Loan" });
    await expect(setProductActive(db, admin, p.id, true)).rejects.toThrow(/Save the loan terms/);
    await saveProductTerms(db, admin, p.id, { ...DEFAULT_POLICY, annualInterestRate: 7 });
    await saveProductTerms(db, admin, p.id, { ...DEFAULT_POLICY, annualInterestRate: 8 });
    // Unused terms are changed in place.
    let rows = await listPolicyVersions(db, p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active" });
    expect((rows[0].parameters as { annualInterestRate: number }).annualInterestRate).toBe(8);
    await setProductActive(db, admin, p.id, true);
    // Once an application uses them, a change leaves that application's terms as they were.
    const applicant = await actor("applicant");
    await db.insert(s.loanApplications).values({ reference: "LMS-261102-902", applicantId: applicant.userId, productId: p.id, policyVersionId: rows[0].id, requestedAmount: "100000", tenorMonths: 6, purpose: "Made on the 8% terms", status: "draft", salarySnapshot: {}, quote: {} } as never);
    await saveProductTerms(db, admin, p.id, { ...DEFAULT_POLICY, annualInterestRate: 9 });
    rows = await listPolicyVersions(db, p.id);
    expect((await getActivePolicy(db, p.id))!.params.annualInterestRate).toBe(9);
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.reference, "LMS-261102-902"));
    expect((await getPolicyVersion(db, app.policyVersionId)).params.annualInterestRate).toBe(8);
    await expect(saveProductTerms(db, admin, p.id, { ...DEFAULT_POLICY, minTenorMonths: 99, maxTenorMonths: 6 })).rejects.toThrow();
    await expect(saveProductTerms(db, await actor("hradmin"), p.id, DEFAULT_POLICY)).rejects.toThrow(/not authorised/);
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
