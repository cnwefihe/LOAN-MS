import crypto from "node:crypto";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { hmac, timingSafeEqualStr } from "@/lib/security/crypto";
import { getSetting } from "./settings";

/**
 * The register opens only after the administrator enters their two-step verification code. It then stays
 * open while they use it, and closes after the time without activity set under Settings > Security. The
 * browser holds a signed token; the time of the last activity is kept on the server.
 */
export const RECORDS_COOKIE = "pau_records";
const key = (token: string) => `register:${token}`;

function readToken(userId: string, value: string | undefined) {
  if (!value) return null;
  const [token, sig] = value.split(".");
  if (!token || !sig || !timingSafeEqualStr(sig, hmac(`register:${userId}:${token}`))) return null;
  return token;
}

export const registerIdleMinutes = (db: Executor) => getSetting(db, "security.registerIdleMinutes");

export async function openRecords(db: Executor, userId: string) {
  const token = crypto.randomBytes(18).toString("base64url");
  await db.execute(sql`insert into rate_limits (key, count, window_start) values (${key(token)}, 1, now()) on conflict (key) do update set window_start = now()`);
  (await cookies()).set(RECORDS_COOKIE, `${token}.${hmac(`register:${userId}:${token}`)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 12 * 3600,
  });
}

/** Whether the register is open for this person; each check counts as activity and keeps it open. */
export async function recordsOpen(db: Executor, userId: string) {
  const token = readToken(userId, (await cookies()).get(RECORDS_COOKIE)?.value);
  if (!token) return false;
  const minutes = await registerIdleMinutes(db);
  const res = await db.execute<{ key: string }>(sql`
    update rate_limits set window_start = now()
    where key = ${key(token)} and window_start > now() - make_interval(mins => ${minutes})
    returning key`);
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}

export async function closeRecords(db: Executor, userId: string) {
  const jar = await cookies();
  const token = readToken(userId, jar.get(RECORDS_COOKIE)?.value);
  if (token) await db.execute(sql`delete from rate_limits where key = ${key(token)}`);
  jar.delete(RECORDS_COOKIE);
}
