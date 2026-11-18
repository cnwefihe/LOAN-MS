/**
 * Server-side sessions. The browser holds only an opaque random token in an httpOnly cookie;
 * the database holds its SHA-256 hash, expiry and revocation state. Roles and permissions are
 * re-read from the database on every request, so revocations take effect immediately.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { getSetting, idleMinutesFor } from "@/server/settings";
import { HUMAN_COOKIE } from "@/server/human-check";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { mfaRequiredFor } from "@/server/services/mfa";
import type { Permission } from "./permissions";

/** The browser signs people out on time; the server allows this much longer, so "Stay signed in" is never refused at the last second. */
const IDLE_GRACE_MS = 60_000;

export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-pau_session" : "pau_session";

export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return { ip: (fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip")) ?? null, userAgent: h.get("user-agent") };
}

/** A fixed upper limit on one sign-in; day to day, the inactivity time set in Settings applies. */
const SESSION_MAX_HOURS = 12;

/** `mfaVerified` is true when the identity provider already performed multi-factor authentication. */
export async function createSession(userId: string, authMethod: "entra" | "dev_fixture", mfaVerified = false): Promise<void> {
  const db = await getDb();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_MAX_HOURS * 3600_000);
  const ctx = await requestContext();
  await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId, authMethod, ipAddress: ctx.ip, userAgent: ctx.userAgent, expiresAt, mfaVerifiedAt: mfaVerified ? new Date() : null });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt,
  });
  // When the security verification is asked at every sign-in, a pass is used up by signing in.
  if ((await getSetting(db, "security.verifyValidMinutes")) === 0) jar.delete(HUMAN_COOKIE);
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256Hex(token)));
  }
  jar.delete(SESSION_COOKIE);
}

/** The current session and person, enforcing idle and absolute timeouts. Memoised per request. */
const resolve = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [s] = await db.select().from(sessions).where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
  if (!s) return null;
  const actor = await loadActor(db, s.userId, await requestContext());
  if (!actor) return null;
  const now = Date.now();
  const idleMinutes = await idleMinutesFor(db, actor.roles);
  if (s.expiresAt.getTime() < now || now - s.lastSeenAt.getTime() > idleMinutes * 60_000 + IDLE_GRACE_MS) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, s.id));
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 30_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, s.id));
  }
  const [u] = await db.select({ mfaEnabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, s.userId));
  const mfaPending = !s.mfaVerifiedAt && (await mfaRequiredFor(db, u, actor.roles));
  return { sessionId: s.id, actor, mfaPending, mfaEnrolled: !!u.mfaEnabledAt };
});

/** The fully signed-in person, or null. Someone who still owes the second sign-in step counts as signed out. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const r = await resolve();
  return r && !r.mfaPending ? r.actor : null;
});

/** For the two-step verification page: the person and session, whether or not the second step is done. */
export async function getSignInState() {
  return resolve();
}

/** For pages: redirect to sign-in when unauthenticated, to /forbidden when lacking permission. */
export async function requireActor(...anyOf: Permission[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect((await resolve())?.mfaPending ? "/mfa" : "/login");
  if (anyOf.length && !anyOf.some((p) => actor.permissions.has(p))) redirect("/forbidden");
  return actor;
}

export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_LOGIN === "true";
}
