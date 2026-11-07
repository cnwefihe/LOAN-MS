import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { readDocument } from "@/server/services/documents";
import { DomainError, ForbiddenError } from "@/server/errors";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const { doc, data } = await readDocument(await getDb(), actor, id);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Disposition": `attachment; filename="${doc.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
    if (err instanceof DomainError) return new NextResponse(err.message, { status: 404 });
    console.error("[documents] read failed", err);
    return new NextResponse("Error", { status: 500 });
  }
}
