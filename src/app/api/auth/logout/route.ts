import { NextResponse, type NextRequest } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { entraConfig } from "@/lib/auth/entra";

export async function POST(req: NextRequest) {
  const idle = (await req.formData().catch(() => null))?.get("reason") === "idle";
  const done = `/login?signedOut=${idle ? "idle" : "1"}`;
  await destroySession();
  const cfg = entraConfig();
  const local = new URL(done, req.url);
  if (!cfg) return NextResponse.redirect(local, 303);
  // Also end the Microsoft session so a shared computer is not left signed in.
  const logout = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/logout`);
  logout.searchParams.set("post_logout_redirect_uri", `${cfg.baseUrl}${done}`);
  return NextResponse.redirect(logout, 303);
}
