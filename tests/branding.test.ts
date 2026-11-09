/** Branding, document security markings, suggested products and administrator privileges. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { pdfText } from "./support/pdf-text";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-brand-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { updateSettingsGroup, uploadBrandAsset, resetBrandAsset, setRolePermission } from "@/server/services/admin";
import { getBranding, getLogo } from "@/server/branding";
import { PdfBuilder } from "@/server/pdf";
import { policyParametersSchema } from "@/lib/finance/policy";
import { SUGGESTED_PRODUCTS } from "@/lib/finance/suggested-products";
import { LOCKED_SUPER_ADMIN_PERMISSIONS, ROLE_DEFINITIONS, ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { contrastRatio } from "@/lib/colour";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("suggested product catalogue", () => {
  it("every suggestion is a valid policy", () => {
    for (const p of SUGGESTED_PRODUCTS) expect(policyParametersSchema.safeParse(p.policy).success, p.code).toBe(true);
  });

  it("is seeded once, open with its starting values, with its document requirements", async () => {
    await seedBase(db); // idempotent
    for (const sp of SUGGESTED_PRODUCTS) {
      const rows = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, sp.code));
      expect(rows).toHaveLength(1);
      expect(rows[0].isActive).toBe(true);
      const versions = await db.select().from(s.policyVersions).where(eq(s.policyVersions.productId, rows[0].id));
      expect(versions.map((v) => v.status)).toEqual(["active"]);
      for (const code of sp.policy.requiredDocumentCodes.filter((c) => c !== "PAYSLIP")) {
        expect((await db.select().from(s.documentRequirements).where(and(eq(s.documentRequirements.productId, rows[0].id), eq(s.documentRequirements.code, code))))).toHaveLength(1);
      }
    }
    const payslip = await db.select().from(s.documentRequirements).where(eq(s.documentRequirements.code, "PAYSLIP"));
    expect(payslip).toHaveLength(1);
  });
});

describe("branding settings", () => {
  it("defaults to the institution's identity and brand blue", async () => {
    const b = await getBranding(db);
    expect(b).toMatchObject({ institutionName: "Pan-Atlantic University", systemName: "Loan Management System", primaryColour: "#2E3A6E", confidentialMarking: "CONFIDENTIAL", footerNotice: "Pan-Atlantic University. Authorised User Only." });
    expect(contrastRatio(b.primaryColour, "#ffffff")).toBeGreaterThan(7);
  });

  it("rejects a brand colour that would make white text unreadable, and only administrators may change it", async () => {
    const admin = await actor("admin");
    await expect(updateSettingsGroup(db, admin, "Organisation and branding", { "branding.primaryColour": "#FFD700" }, false)).rejects.toThrow(/contrast/);
    await expect(updateSettingsGroup(db, await actor("accounts"), "Organisation and branding", { "branding.primaryColour": "#1F4E79" }, false)).rejects.toThrow(/not authorised/);
    expect(await updateSettingsGroup(db, admin, "Organisation and branding", { "branding.primaryColour": "#1F4E79", "org.systemName": "Staff Loan Management System" }, false)).toBe(2);
    expect(await updateSettingsGroup(db, admin, "Organisation and branding", { "branding.primaryColour": "#1F4E79" }, false)).toBe(0); // unchanged
    const b = await getBranding(db);
    expect(b.primaryColour).toBe("#1F4E79");
    expect(b.systemName).toBe("Staff Loan Management System");
    await updateSettingsGroup(db, admin, "Organisation and branding", { "branding.primaryColour": "#2E3A6E", "org.systemName": "Loan Management System" }, false);
  });

  it("sensitive controls need explicit confirmation", async () => {
    const admin = await actor("admin");
    await expect(updateSettingsGroup(db, admin, "Financial controls", { "finance.makerChecker.repayment": true }, false)).rejects.toThrow(/confirmation/);
    expect(await updateSettingsGroup(db, admin, "Financial controls", { "finance.makerChecker.repayment": true }, true)).toBe(1);
    await updateSettingsGroup(db, admin, "Financial controls", { "finance.makerChecker.repayment": false }, true);
  });

  it("accepts only real PNG or JPEG logos and can restore the bundled file", async () => {
    const admin = await actor("admin");
    expect((await getLogo(db, "logo"))?.source).toBe("bundled");
    await expect(uploadBrandAsset(db, admin, "logo", { buffer: Buffer.from("<svg onload=alert(1)>"), fileName: "logo.png" })).rejects.toThrow(/PNG or JPEG/);
    const png = fs.readFileSync(path.join(process.cwd(), "public", "branding", "crest.png"));
    await uploadBrandAsset(db, admin, "logo", { buffer: png, fileName: "new-logo.png" });
    const uploaded = await getLogo(db, "logo");
    expect(uploaded?.source).toBe("uploaded");
    expect(uploaded?.bytes.equals(png)).toBe(true);
    expect((await getBranding(db)).logoVersion).toMatch(/^logo:/);
    await resetBrandAsset(db, admin, "logo");
    expect((await getLogo(db, "logo"))?.source).toBe("bundled");
  });
});

describe("PDF security markings", () => {
  it("prints the diagonal marking, footer notice, reference and page numbers on every page and registers the document", async () => {
    const pdf = await PdfBuilder.create(db, { kind: "sample", title: "Marking Test", subtitle: "Multi-page check" });
    pdf.summary([{ label: "Outstanding", value: "NGN 1,000.00" }], ["A finding."]);
    pdf.table(["#", "Text"], Array.from({ length: 120 }, (_, i) => [String(i + 1), `Row ${i + 1}`]));
    const bytes = await pdf.finish(db, null, { entityType: "test" });
    const { text, pages } = await pdfText(bytes);
    expect(pages).toBeGreaterThanOrEqual(3);
    const count = (needle: string) => text.split(needle).length - 1;
    expect(count("Pan-Atlantic University. Authorised User Only.")).toBe(pages);
    expect(count("CONFIDENTIAL")).toBe(pages); // the diagonal watermark only: no header or footer marking
    expect(text).not.toContain("For official use only");
    expect(count(`Page ${pages} of ${pages}`)).toBe(1);
    expect(text).toContain(pdf.reference);
    expect(text).toContain("Summary");
    expect(text).toContain("Pan-Atlantic University");
    expect(text).not.toMatch(/\u2014/);
    const [reg] = await db.select().from(s.issuedDocuments).where(eq(s.issuedDocuments.reference, pdf.reference));
    expect(reg.kind).toBe("sample");
  });

  it("follows the administrator's marking, footer and watermark settings", async () => {
    const admin = await actor("admin");
    await updateSettingsGroup(db, admin, "Documents", { "documents.confidentialMarking": "RESTRICTED", "documents.footerNotice": "{institution} Bursary. Staff only." }, false);
    const first = await pdfText(await (await PdfBuilder.create(db, { kind: "sample", title: "Restricted Test" })).finish(db, null));
    expect(first.text.split("RESTRICTED").length - 1).toBe(first.pages);
    expect(first.text).toContain("Pan-Atlantic University Bursary. Staff only.");
    expect(first.text).not.toContain("CONFIDENTIAL");
    await updateSettingsGroup(db, admin, "Documents", { "documents.watermarkEnabled": false }, false);
    const second = await pdfText(await (await PdfBuilder.create(db, { kind: "sample", title: "No Watermark" })).finish(db, null));
    expect(second.text).not.toContain("RESTRICTED");
    await updateSettingsGroup(db, admin, "Documents", { "documents.confidentialMarking": "CONFIDENTIAL", "documents.watermarkEnabled": true, "documents.footerNotice": "{institution}. Authorised User Only." }, false);
  });
});

describe("administrator privileges", () => {
  it("the Super Administrator role holds every administration permission and portfolio oversight, but no staff pay data", () => {
    const granted = ROLE_DEFINITIONS.SUPER_ADMIN.permissions;
    for (const p of ALL_PERMISSIONS.filter((x) => x.startsWith("admin."))) expect(granted).toContain(p);
    for (const p of ["accounts.view", "reports.export"] as const) expect(granted).toContain(p);
    // As the privacy notice states: no salaries, payslips, staff records or uploaded documents.
    for (const p of ["hr.queue.view", "hr.staff.view", "hr.staff.edit", "approval.queue.view", "documents.view_all"] as const) expect(granted).not.toContain(p);
    expect(granted).not.toContain("transaction.approve"); // segregation of duties
  });

  it("locked administration permissions cannot be removed, and seeding restores any that go missing", async () => {
    const admin = await actor("admin");
    const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "SUPER_ADMIN"));
    const [perm] = await db.select().from(s.permissions).where(eq(s.permissions.code, "admin.settings.manage"));
    expect(LOCKED_SUPER_ADMIN_PERMISSIONS).toContain("admin.settings.manage");
    await expect(setRolePermission(db, admin, role.id, perm.id, false)).rejects.toThrow(/locked/);
    await db.delete(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, perm.id)));
    await seedBase(db);
    expect(await db.select().from(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, perm.id)))).toHaveLength(1);
  });
});
