/**
 * Two-step verification for staff who can see or move other people's money and data: HR, the Bursary,
 * final approvers and administrators (and anyone else who chooses to turn it on). After the first
 * sign-in step, the session stays limited until a six-digit authenticator code (or a one-time
 * recovery code) is entered. A Microsoft sign-in already completed with Microsoft MFA counts.
 */
import { and, eq } from "drizzle-orm";
import QRCode from "qrcode";
import type { Executor } from "@/db";
import { users, sessions } from "@/db/schema";
import { ROLE_CODES, type RoleCode } from "@/lib/auth/permissions";
import { encryptString, decryptString, sha256Hex } from "@/lib/security/crypto";
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes, normaliseRecoveryCode, totp } from "@/lib/security/totp";
import { getSetting } from "../settings";
import { audit } from "../audit";
import { assertCan, type Actor } from "../actor";
import { DomainError } from "../errors";

type UserRow = typeof users.$inferSelect;

/** Roles that need the second step when Settings > Security is set to "Approval and payment roles". */
export const MFA_ROLES: RoleCode[] = ["HR_ADMIN", "BURSARY_OFFICER", "HR_DIRECTOR", "ACCOUNTS_ADMIN", "ACCOUNTS_OFFICER", "SUPER_ADMIN"];

/**
 * Whether this person must complete the second step before using the system, as set under
 * Settings > Security. Someone Microsoft has already asked for a second step is not asked again (see the callback).
 */
export async function mfaRequiredFor(db: Executor, user: Pick<UserRow, "mfaEnabledAt">, roles: RoleCode[]): Promise<boolean> {
  if (user.mfaEnabledAt) return true; // turned on voluntarily, or already set up
  const scope = await getSetting(db, "security.mfaScope");
  if (scope === "everyone") return true;
  if (scope === "off") return false;
  // Roles added by an administrator are treated as staff roles, so they need the second step too.
  return roles.some((r) => MFA_ROLES.includes(r) || !ROLE_CODES.includes(r));
}

export async function markSessionVerified(db: Executor, sessionId: string) {
  await db.update(sessions).set({ mfaVerifiedAt: new Date() }).where(eq(sessions.id, sessionId));
}

interface Pending { secret: string; codes: string[] }

/** Starts (or resumes) set-up: a new secret, a QR code for the authenticator app and recovery codes. */
export async function beginEnrolment(db: Executor, userId: string, issuer: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new DomainError("Account not found.");
  if (u.mfaEnabledAt) throw new DomainError("Two-step verification is already set up.");
  let pending: Pending;
  if (u.mfaPending) pending = JSON.parse(decryptString(u.mfaPending)) as Pending;
  else {
    pending = { secret: generateSecret(), codes: generateRecoveryCodes() };
    await db.update(users).set({ mfaPending: encryptString(JSON.stringify(pending)) }).where(eq(users.id, userId));
  }
  const uri = otpauthUri(pending.secret, u.email, issuer);
  return { secret: pending.secret, recoveryCodes: pending.codes, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200, errorCorrectionLevel: "M" }) };
}

/** Confirms set-up with a code from the app; the current session counts as verified. */
export async function confirmEnrolment(db: Executor, userId: string, sessionId: string, code: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u?.mfaPending) throw new DomainError("Start set-up again: no set-up is in progress.");
  const pending = JSON.parse(decryptString(u.mfaPending)) as Pending;
  if (!verifyTotp(pending.secret, code)) throw new DomainError("That code is not correct. Check the time on your phone and enter the current six-digit code.");
  await db.update(users).set({
    mfaSecret: encryptString(pending.secret), mfaEnabledAt: new Date(), mfaPending: null,
    mfaRecoveryHashes: pending.codes.map((c) => sha256Hex(normaliseRecoveryCode(c))),
  }).where(eq(users.id, userId));
  await markSessionVerified(db, sessionId);
  await audit(db, { userId, displayName: u.displayName } as Actor, { action: "mfa.enabled", entityType: "user", entityId: userId, summary: "Two-step verification set up" });
}

/** Second sign-in step: a six-digit code, or a one-time recovery code (which is then used up). */
export async function verifySecondStep(db: Executor, userId: string, sessionId: string, code: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u?.mfaSecret) throw new DomainError("Two-step verification is not set up for this account.");
  const clean = code.trim();
  let method = "authenticator";
  if (!verifyTotp(decryptString(u.mfaSecret), clean)) {
    const hash = sha256Hex(normaliseRecoveryCode(clean));
    const remaining = u.mfaRecoveryHashes ?? [];
    if (!/^\D*\d{6}\D*$/.test(clean) && remaining.includes(hash)) {
      await db.update(users).set({ mfaRecoveryHashes: remaining.filter((h) => h !== hash) }).where(eq(users.id, userId));
      method = `recovery code (${remaining.length - 1} left)`;
    } else {
      await audit(db, { userId, displayName: u.displayName } as Actor, { action: "mfa.failed", entityType: "user", entityId: userId, summary: "Incorrect two-step verification code" });
      throw new DomainError("That code is not correct. Enter the current six-digit code from your authenticator app.");
    }
  }
  await markSessionVerified(db, sessionId);
  await audit(db, { userId, displayName: u.displayName } as Actor, { action: "mfa.verified", entityType: "user", entityId: userId, summary: `Signed in with ${method}` });
}

/** Administrator reset, e.g. after a lost phone: the person sets up again at their next sign-in. */
export async function resetMfa(db: Executor, actor: Actor, userId: string) {
  assertCan(actor, "admin.users.manage");
  if (userId === actor.userId) throw new DomainError("Ask another administrator to reset your own two-step verification.");
  await db.update(users).set({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryHashes: null, mfaPending: null }).where(eq(users.id, userId));
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId)));
  await audit(db, actor, { action: "mfa.reset", entityType: "user", entityId: userId, summary: "Two-step verification reset by an administrator; sessions ended" });
}

/** Development fixtures only: the current code, so test accounts can sign in without a phone. */
export async function devFixtureCode(db: Executor, userId: string): Promise<string | null> {
  if (process.env.NODE_ENV === "production" || process.env.AUTH_DEV_LOGIN !== "true") return null;
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u?.isDevFixture) return null;
  if (u.mfaSecret) return totp(decryptString(u.mfaSecret));
  if (u.mfaPending) return totp((JSON.parse(decryptString(u.mfaPending)) as Pending).secret);
  return null;
}
