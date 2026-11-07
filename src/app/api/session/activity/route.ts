import { NextResponse } from "next/server";
import { getActor } from "@/lib/auth/session";

/** The browser reports that the person is still working, even on a page that makes no other requests. */
export async function POST() {
  return new NextResponse(null, { status: (await getActor()) ? 204 : 401 });
}
