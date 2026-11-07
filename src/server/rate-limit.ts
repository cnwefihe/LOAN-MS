import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { DomainError } from "./errors";

/**
 * Fixed-window rate limiter backed by the database so limits hold across server instances.
 * Throws a DomainError when the limit is exceeded.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const db = await getDb();
  const res = await db.execute<{ count: number }>(sql`
    insert into rate_limits (key, count, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end
    returning count`);
  const count = Number((res as unknown as { rows: { count: number }[] }).rows[0].count);
  if (count > limit) throw new DomainError("Too many requests. Please wait a moment and try again.", "rate_limited");
}
