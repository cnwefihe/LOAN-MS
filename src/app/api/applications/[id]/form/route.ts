import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { applicationFormPdf, guarantorFormPdf } from "@/server/services/forms";
import { ForbiddenError, DomainError, NotFoundError } from "@/server/errors";

/** ?type=application (default) or ?type=guarantor */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const make = req.nextUrl.searchParams.get("type") === "guarantor" ? guarantorFormPdf : applicationFormPdf;
    const { bytes, fileName } = await make(await getDb(), actor, id);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${fileName}"`, "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
    if (err instanceof NotFoundError || err instanceof DomainError) return new NextResponse("Not found", { status: 404 });
    console.error("[application form]", err);
    return new NextResponse("Error", { status: 500 });
  }
}
