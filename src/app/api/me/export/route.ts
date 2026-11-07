import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { exportMyData } from "@/server/services/privacy";
import { rateLimit } from "@/server/rate-limit";
import { todayLagos } from "@/lib/finance/dates";

export async function GET() {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  try {
    await rateLimit(`export-me:${actor.userId}`, 5, 3600);
  } catch {
    return new NextResponse("Too many export requests. Try again later.", { status: 429 });
  }
  const data = await exportMyData(await getDb(), actor);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="my-pau-loan-data-${todayLagos()}.json"`, "Cache-Control": "private, no-store" },
  });
}
