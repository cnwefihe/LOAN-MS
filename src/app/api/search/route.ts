import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { searchRecords } from "@/server/services/search";

/** Suggestions for the search box as the person types (same visibility rules as the search page). */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ suggestions: [] });
  const r = await searchRecords(await getDb(), actor, q, 5);
  const suggestions = [
    ...r.apps.map((a) => ({ kind: "Application", label: a.app.reference, detail: a.name, href: a.href })),
    ...r.loans.map((l) => ({ kind: "Loan", label: l.loan.accountNumber, detail: l.name, href: l.href })),
    ...r.people.map((p) => ({ kind: "Staff", label: p.u.displayName, detail: p.staffNumber ?? p.u.email, href: p.href })),
  ].slice(0, 8);
  return NextResponse.json({ suggestions }, { headers: { "Cache-Control": "private, no-store" } });
}
