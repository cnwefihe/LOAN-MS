/** Two-step verification: RFC 6238 codes, who must use it, set-up, sign-in, recovery codes and reset. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-mfa-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { base32Encode, totpAt, totp, verifyTotp } from "@/lib/security/totp";
import { mfaRequiredFor, beginEnrolment, confirmEnrolment, verifySecondStep, resetMfa, MFA_ROLES } from "@/server/services/mfa";
import { updateSettingsGroup } from "@/server/services/admin";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const newSession = async (userId: string) => (await db.insert(s.sessions).values({ tokenHash: `t-${Math.random()}`, userId, authMethod: "dev_fixture", expiresAt: new Date(Date.now() + 3600_000) }).returning())[0];

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
    // Off by default so a new installation can be explored; administrators switch it on before go-live.
    await tx.update(s.systemSettings).set({ value: true as never }).where(eq(s.systemSettings.key, "security.mfaRequired"));
  });
});

describe("authenticator codes (RFC 6238)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the published SHA-1 test values", () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe("005924");
  });
  it("accepts one step of clock drift and nothing further", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });
});

describe("two-step verification", () => {
  it("is required for HR, Accounts, approvers and administrators, not ordinary staff", async () => {
    expect(MFA_ROLES).toEqual(expect.arrayContaining(["HR_ADMIN", "BURSARY_OFFICER", "HR_DIRECTOR", "ACCOUNTS_ADMIN", "ACCOUNTS_OFFICER", "SUPER_ADMIN"]));
    for (const k of ["hradmin", "bursary", "hrdirector", "accounts", "accadmin", "admin"]) expect(await mfaRequiredFor(db, { mfaEnabledAt: null }, (await actor(k)).roles), k).toBe(true);
    expect(await mfaRequiredFor(db, { mfaEnabledAt: null }, (await actor("applicant")).roles)).toBe(false);
    expect(await mfaRequiredFor(db, { mfaEnabledAt: new Date() }, (await actor("applicant")).roles)).toBe(true); // chose to turn it on
  });

  it("is set up with the app, then each sign-in needs a code; recovery codes work once", async () => {
    const userId = ids.accounts;
    const setup = await beginEnrolment(db, userId, "PAU LMS");
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect(setup.recoveryCodes).toHaveLength(8);
    expect((await beginEnrolment(db, userId, "PAU LMS")).secret).toBe(setup.secret); // resuming shows the same secret

    const s1 = await newSession(userId);
    await expect(confirmEnrolment(db, userId, s1.id, "000000")).rejects.toThrow(/not correct/);
    await confirmEnrolment(db, userId, s1.id, totp(setup.secret));
    const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
    expect(u.mfaEnabledAt).not.toBeNull();
    expect(u.mfaSecret).not.toContain(setup.secret); // encrypted at rest
    expect((await db.select().from(s.sessions).where(eq(s.sessions.id, s1.id)))[0].mfaVerifiedAt).not.toBeNull();

    const s2 = await newSession(userId);
    await expect(verifySecondStep(db, userId, s2.id, "999999")).rejects.toThrow(/not correct/);
    await verifySecondStep(db, userId, s2.id, totp(setup.secret));
    const s3 = await newSession(userId);
    await verifySecondStep(db, userId, s3.id, setup.recoveryCodes[0].toLowerCase());
    await expect(verifySecondStep(db, userId, (await newSession(userId)).id, setup.recoveryCodes[0])).rejects.toThrow(/not correct/);
    const log = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, userId));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["mfa.enabled", "mfa.verified", "mfa.failed"]));
  });

  it("an administrator can reset it (not their own), which ends the person's sessions", async () => {
    const admin = await actor("admin");
    await expect(resetMfa(db, await actor("accounts"), ids.accounts)).rejects.toThrow(/not authorised/);
    await expect(resetMfa(db, admin, ids.admin)).rejects.toThrow(/another administrator/);
    await resetMfa(db, admin, ids.accounts);
    const [u] = await db.select().from(s.users).where(eq(s.users.id, ids.accounts));
    expect(u.mfaEnabledAt).toBeNull();
    const live = (await db.select().from(s.sessions).where(eq(s.sessions.userId, ids.accounts))).filter((x) => !x.revokedAt);
    expect(live).toHaveLength(0);
  });

  it("the requirement can be switched off only with confirmation, as a sensitive setting", async () => {
    const admin = await actor("admin");
    await expect(updateSettingsGroup(db, admin, "Security", { "security.mfaRequired": false }, false)).rejects.toThrow(/confirmation/);
    await updateSettingsGroup(db, admin, "Security", { "security.mfaRequired": false }, true);
    expect(await mfaRequiredFor(db, { mfaEnabledAt: null }, (await actor("hradmin")).roles)).toBe(false);
    await updateSettingsGroup(db, admin, "Security", { "security.mfaRequired": true }, true);
  });
});
