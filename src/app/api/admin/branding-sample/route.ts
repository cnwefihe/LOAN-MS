import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { PdfBuilder } from "@/server/pdf";

/** A sample document so administrators can check logos and markings before staff see them. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  if (!can(actor, "admin.branding.manage")) return new NextResponse("Forbidden", { status: 403 });
  const db = await getDb();
  const pdf = await PdfBuilder.create(db, { kind: "sample", title: "Sample Document (not valid)", subtitle: "Branding preview produced from Administration > Branding and documents" });
  pdf.summary([
    { label: "Amount", value: "NGN 1,250,000.00" }, { label: "Status", value: "Confirmed", tone: "good" },
    { label: "Days past due", value: "0", tone: "good" }, { label: "Risk", value: "Low", tone: "warn" },
  ], ["This is how headline figures and the executive summary appear on receipts, statements and reports.", "This sample has no legal or financial effect."]);
  pdf.heading("Example details");
  pdf.keyValues([["Prepared for", actor.displayName], ["Purpose", "Checking logo, colours and security markings"]]);
  pdf.heading("Example table");
  pdf.table(["#", "Due date", "Instalment", "Status"], [["1", "25 Nov 2026", "NGN 52,500.00", "Paid"], ["2", "25 Dec 2026", "NGN 52,500.00", "Due"]], ["left", "left", "right", "left"]);
  const bytes = await pdf.finish(db, actor, { entityType: "sample" });
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="sample-document.pdf"', "Cache-Control": "private, no-store" } });
}
