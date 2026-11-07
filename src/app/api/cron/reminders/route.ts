/**
 * Reminder endpoint for an external scheduler, called often so timings in minutes are met:
 *   POST /api/cron/reminders   with header  Authorization: Bearer $CRON_SECRET
 * Safe to repeat: each reminder goes out once per period.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { runReminders } from "@/server/services/loans";
import { processOutbox } from "@/server/email";
import { timingSafeEqualStr } from "@/lib/security/crypto";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqualStr(auth, `Bearer ${secret}`)) return new NextResponse("Unauthorised", { status: 401 });
  const result = await runReminders(await getDb());
  const email = await processOutbox(500);
  return NextResponse.json({ ...result, email });
}
