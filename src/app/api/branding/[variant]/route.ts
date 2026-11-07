import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getLogo, isLogoVariant } from "@/server/branding";

/** Public: logos are needed on the sign-in page. URLs carry a version, so responses can be cached. */
export async function GET(_: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (!isLogoVariant(variant)) return new NextResponse("Not found", { status: 404 });
  const logo = await getLogo(await getDb(), variant);
  if (!logo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: { "Content-Type": logo.mimeType, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
