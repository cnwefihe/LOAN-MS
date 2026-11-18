import { sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { getSettings } from "./settings";

/**
 * Locks a device out of the security verification after too many failed attempts. The number of attempts
 * and how long the lock lasts are set by an administrator under Settings > Security. Failures are counted
 * per device (a cookie set by the browser on its first visit) and reset after the lock period or a success.
 */
export const DEVICE_COOKIE = "pau_device";
const key = (device: string) => `human-fail:${device}`;

export async function lockRules(db: Executor) {
  const s = await getSettings(db, ["security.verifyMaxFailures", "security.verifyLockMinutes"]);
  return { max: s["security.verifyMaxFailures"], minutes: s["security.verifyLockMinutes"] };
}

type Row = { count: number; secs: number };
const rows = (res: unknown) => (res as { rows: Row[] }).rows;

/** Seconds left on the lock for this device, or 0 when it may try. */
export async function lockedFor(db: Executor, device: string): Promise<number> {
  const { max, minutes } = await lockRules(db);
  const [r] = rows(await db.execute(sql`
    select count, extract(epoch from (window_start + make_interval(mins => ${minutes})) - now())::float as secs
    from rate_limits where key = ${key(device)}`));
  return r && Number(r.count) >= max && Number(r.secs) > 0 ? Math.ceil(Number(r.secs)) : 0;
}

/**
 * Records a failed attempt. Failures count within the lock period; the attempt that reaches the limit starts
 * the lock. Returns the attempts left, and the seconds locked when the limit is reached.
 */
export async function recordFailure(db: Executor, device: string): Promise<{ left: number; lockedFor: number }> {
  const { max, minutes } = await lockRules(db);
  const [r] = rows(await db.execute(sql`
    insert into rate_limits (key, count, window_start) values (${key(device)}, 1, now())
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(mins => ${minutes}) then 1 else rate_limits.count + 1 end,
      window_start = case
        when rate_limits.window_start < now() - make_interval(mins => ${minutes}) then now()
        when rate_limits.count + 1 >= ${max} then now()
        else rate_limits.window_start end
    returning count, 0::float as secs`));
  const count = Number(r.count);
  return count >= max ? { left: 0, lockedFor: minutes * 60 } : { left: max - count, lockedFor: 0 };
}

export async function clearFailures(db: Executor, device: string) {
  await db.execute(sql`delete from rate_limits where key = ${key(device)}`);
}

export const lockMessage = (secs: number) => {
  const mins = Math.ceil(secs / 60);
  return `Too many failed attempts. Please try again in ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
};
