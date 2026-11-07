import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { entraConfig, msalClient, cryptoProvider, redirectUri, ENTRA_SCOPES } from "@/lib/auth/entra";
import { hmac, randomToken } from "@/lib/security/crypto";
import { rateLimit } from "@/server/rate-limit";

const OIDC_COOKIE = "pau_oidc";

export async function GET(req: NextRequest) {
  const cfg = entraConfig();
  if (!cfg) return NextResponse.redirect(new URL("/login?error=sso_not_configured", req.url));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  try {
    await rateLimit(`login:${ip}`, 30, 300);
  } catch {
    return NextResponse.redirect(new URL("/login?error=rate_limited", req.url));
  }

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
