import { sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { DomainError } from "./errors";
import { getSettings } from "./settings";

/**
 * Locks an account after too many wrong two-step verification codes, wherever a code is asked for: at
 * sign-in, when setting up, and when opening the Register or confirming a payment. How many wrong codes are
 * allowed and how long the lock lasts are set under Settings > Security. Kept apart from the slider lock
 * (per device) and the limit on requests to ICT support, so changing one never affects the others.
 */
const key = (userId: string) => `code-fail:${userId}`;

async function rules(db: Executor) {
  const s = await getSettings(db, ["security.codeFailuresMax", "security.codeLockMinutes"]);
  return { max: s["security.codeFailuresMax"], minutes: s["security.codeLockMinutes"] };
}

type Row = { count: number; secs: number };
const first = (res: unknown) => (res as { rows: Row[] }).rows[0];

const minutesText = (secs: number) => { const m = Math.ceil(secs / 60); return `${m} ${m === 1 ? "minute" : "minutes"}`; };

/** Refuses while the account is locked, saying how long is left. */
export async function assertCodeNotLocked(db: Executor, userId: string) {
  const { max, minutes } = await rules(db);
  const r = first(await db.execute(sql`
    select count, extract(epoch from (window_start + make_interval(mins => ${minutes})) - now())::float as secs
    from rate_limits where key = ${key(userId)}`));
  if (r && Number(r.count) >= max && Number(r.secs) > 0) {
    throw new DomainError(`Too many wrong codes. For your security this account is locked for ${minutesText(Number(r.secs))}. If you have lost your phone, use a recovery code once the lock ends, or contact ICT support.`, "code_locked");
  }
}

/** Counts a wrong code. The one that reaches the limit starts the lock. Returns the tries left. */
export async function recordWrongCode(db: Executor, userId: string): Promise<number> {
  const { max, minutes } = await rules(db);
  const r = first(await db.execute(sql`
    insert into rate_limits (key, count, window_start) values (${key(userId)}, 1, now())
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(mins => ${minutes}) then 1 else rate_limits.count + 1 end,
      window_start = case
        when rate_limits.window_start < now() - make_interval(mins => ${minutes}) then now()
        when rate_limits.count + 1 >= ${max} then now()
        else rate_limits.window_start end
    returning count, 0::float as secs`));
  return Math.max(0, max - Number(r.count));
}

export async function clearWrongCodes(db: Executor, userId: string) {
  await db.execute(sql`delete from rate_limits where key = ${key(userId)}`);
}

/**
 * Runs a code check: refused while locked; a wrong code (an error with the code "wrong_code") is counted,
 * and the message says how many tries are left; a right code clears the count.
 */
export async function withCodeLock<T>(db: Executor, userId: string, check: () => Promise<T>): Promise<T> {
  await assertCodeNotLocked(db, userId);
  try {
    const out = await check();
    await clearWrongCodes(db, userId);
    return out;
  } catch (err) {
    if (err instanceof DomainError && err.code === "wrong_code") {
      const left = await recordWrongCode(db, userId);
      if (left === 0) await assertCodeNotLocked(db, userId);
      throw new DomainError(`${err.message} ${left === 1 ? "1 try left" : `${left} tries left`} before the account is locked for a while.`, "wrong_code");
    }
    throw err;
  }
}
