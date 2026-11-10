import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { myDataPdf } from "@/server/services/privacy";
import { rateLimit } from "@/server/rate-limit";
import { todayLagos } from "@/lib/finance/dates";

/** "Download my data": every record held about the signed-in person, as a PDF. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  try {
    await rateLimit(`export-me:${actor.userId}`, 5, 3600);
  } catch {
    return new NextResponse("Too many export requests. Try again later.", { status: 429 });
  }
  const pdf = await myDataPdf(await getDb(), actor);
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="my-loan-data-${todayLagos()}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
