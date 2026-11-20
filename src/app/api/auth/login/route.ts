import { appUrl } from "@/lib/app-url";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { entraConfig, msalClient, cryptoProvider, redirectUri, ENTRA_SCOPES } from "@/lib/auth/entra";
import { hmac, randomToken } from "@/lib/security/crypto";
import { hasPassed, HUMAN_COOKIE } from "@/server/human-check";

const OIDC_COOKIE = "pau_oidc";

export async function GET(req: NextRequest) {
  const cfg = entraConfig();
  if (!cfg) return NextResponse.redirect(appUrl("/login?error=sso_not_configured", req));
  if (!hasPassed(req.cookies.get(HUMAN_COOKIE)?.value)) return NextResponse.redirect(appUrl("/login?error=human_check", req));
  // No limit by network address: most staff share the campus address. The security check before this
  // step, and Microsoft's own protection of passwords, guard against misuse.

  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const rt = req.nextUrl.searchParams.get("returnTo");
  const returnTo = rt && rt.startsWith("/") && !rt.startsWith("//") ? rt : "/home";

  const payload = Buffer.from(JSON.stringify({ state, nonce, verifier, returnTo, iat: Date.now() })).toString("base64url");
  (await cookies()).set(OIDC_COOKIE, `${payload}.${hmac(payload)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: 600,
  });

  const url = await msalClient(cfg).getAuthCodeUrl({
    scopes: ENTRA_SCOPES,
    redirectUri: redirectUri(cfg),
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    nonce,
    prompt: "select_account",
  });
  return NextResponse.redirect(url);
}
