/** Tampered-input and authorisation hardening: server actions' bound values are client-controllable. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-hard-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { saveDraft, postMessage, getApplicationDetail } from "@/server/services/applications";
import { decideApplication } from "@/server/services/approvals";
import { canAccessDocument, storeDocument } from "@/server/services/documents";
import { setRolePermission } from "@/server/services/admin";
import { toMessage } from "@/server/action";

let db: Database;
let productId: string;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k]))!;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
});

describe("hardening", () => {
  let appId: string;

  it("applicants cannot forge correction requests or internal notes", async () => {
    const a = await actor("applicant");
    appId = (await saveDraft(db, a, { productId, requestedAmount: "100000", tenorMonths: 6, purpose: "Hardening test draft", guarantorEmails: [] })).id;
    await expect(postMessage(db, a, appId, "correction", "Fake HR correction")).rejects.toThrow(/not authorised/);
    await expect(postMessage(db, a, appId, "internal", "Fake internal note")).rejects.toThrow(/not authorised/);
    await expect(postMessage(db, a, appId, "bogus" as "clarification", "x y z")).rejects.toThrow(/Unknown message type/);
    await postMessage(db, await actor("hradmin"), appId, "correction", "Please attach your latest payslip.");
  });

  it("unrelated staff cannot read another person's application", async () => {
    await expect(getApplicationDetail(db, await actor("linemanager"), appId)).rejects.toThrow(/do not have access/);
  });

  it("approval service rejects unknown decisions even if the action layer is bypassed", async () => {
    await expect(decideApplication(db, await actor("accadmin"), appId, { decision: "approve_everything" as "approved", comments: "tampered request" })).rejects.toThrow(/Unknown decision/);
  });

  it("internal HR documents are hidden from the applicant", async () => {
    const hr = await actor("hradmin");
    const doc = await storeDocument(db, hr, { buffer: Buffer.from("%PDF-1.4"), fileName: "hr.pdf", mimeType: "application/pdf", category: "hr_verification", title: "HR check", applicationId: appId });
    expect(await canAccessDocument(db, await actor("applicant"), doc)).toBe(false);
    expect(await canAccessDocument(db, hr, doc)).toBe(true);
  });

  it("financial checker rights cannot be granted to the Super Administrator role", async () => {
    const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "SUPER_ADMIN"));
    const [perm] = await db.select().from(s.permissions).where(eq(s.permissions.code, "transaction.approve"));
    await expect(setRolePermission(db, await actor("admin"), role.id, perm.id, true)).rejects.toThrow(/segregation of duties/);
  });

  it("malformed ids map to a safe message", async () => {
    const err = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, "not-a-uuid")).catch((e) => e);
    expect(toMessage(err)).toBe("That record could not be found.");
  });
});
