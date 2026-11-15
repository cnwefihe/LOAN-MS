/**
 * Scheduled servicing endpoint for an external scheduler (Azure Logic App / cron):
 *   POST /api/cron/servicing   with header  Authorization: Bearer $CRON_SECRET
 * The scheduler calls it hourly; the check itself runs only as often as the administrator has set
 * (Settings, Automation).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { automaticCheckDue, runServicing } from "@/server/services/loans";
import { processOutbox } from "@/server/email";
import { timingSafeEqualStr } from "@/lib/security/crypto";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqualStr(auth, `Bearer ${secret}`)) return new NextResponse("Unauthorised", { status: 401 });
  const db = await getDb();
  const due = await automaticCheckDue(db);
  if (!due.due) return NextResponse.json({ skipped: true, nextAfter: due.nextAfter });
  const result = await runServicing(db, null);
  const email = await processOutbox(500);
  return NextResponse.json({ ...result, email });
}
