import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { receiptPdf } from "@/server/services/loans";
import { ForbiddenError, DomainError } from "@/server/errors";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const { bytes, fileName } = await receiptPdf(await getDb(), actor, id);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${fileName}"`, "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
    if (err instanceof DomainError) return new NextResponse(err.message, { status: 404 });
    console.error("[receipt]", err);
    return new NextResponse("Error", { status: 500 });
  }
}
