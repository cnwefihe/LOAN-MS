import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Executor } from "@/db";
import { roles, sessions, userRoles } from "@/db/schema";
import { audit } from "./audit";
import { getSetting } from "./settings";

/**
 * How many sessions one person may have at the same time, set under Settings > Security: one for most
 * people, more for Super Administrators. Signing in again ends the oldest sessions beyond the limit, so the
 * newest sign-in always works and older devices are signed out.
 */
export async function endExtraSessions(db: Executor, userId: string): Promise<number> {
  const held = await db.select({ code: roles.code }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId));
  const admin = held.some((r) => r.code === "SUPER_ADMIN");
  const limit = await getSetting(db, admin ? "security.maxSessionsAdmin" : "security.maxSessionsUsers");
  const live = await db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt), desc(sessions.lastSeenAt));
  const extra = live.slice(limit).map((s) => s.id);
  if (!extra.length) return 0;
  await db.update(sessions).set({ revokedAt: new Date(), endedReason: "limit" }).where(inArray(sessions.id, extra));
  await audit(db, null, { action: "session.ended_by_limit", entityType: "user", entityId: userId, summary: `${extra.length} older ${extra.length === 1 ? "session" : "sessions"} ended: ${limit} at a time allowed` });
  return extra.length;
}
