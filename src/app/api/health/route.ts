/** Liveness/readiness probe for the load balancer / App Service health check. Exposes no secrets or data. */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { storage } from "@/server/storage";

export const dynamic = "force-dynamic";

async function timed(fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]);
    return { ok: true, ms: Date.now() - t };
  } catch {
    return { ok: false, ms: Date.now() - t };
  }
}

export async function GET() {
  const database = await timed(async () => (await getDb()).execute(sql`select 1`));
  const documents = await timed(() => storage().ping());
  const ok = database.ok && documents.ok;
  return NextResponse.json(
    { status: ok ? "ok" : "degraded", checks: { database, documents }, time: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
