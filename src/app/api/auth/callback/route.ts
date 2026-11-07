import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { entraConfig, msalClient, redirectUri, ENTRA_SCOPES, fetchGraphProfile } from "@/lib/auth/entra";
import { hmac, timingSafeEqualStr } from "@/lib/security/crypto";
import { createSession } from "@/lib/auth/session";
import { provisionEntraUser } from "@/server/services/identity";
import { DomainError } from "@/server/errors";

const OIDC_COOKIE = "pau_oidc";

function fail(req: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(code)}`, req.url));
}

export async function GET(req: NextRequest) {
  const cfg = entraConfig();
  if (!cfg) return fail(req, "sso_not_configured");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, "sso_denied");
  const code = params.get("code");
  const state = params.get("state");

  const jar = await cookies();
  const raw = jar.get(OIDC_COOKIE)?.value;
  jar.delete(OIDC_COOKIE);
  if (!code || !state || !raw) return fail(req, "invalid_state");

  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !timingSafeEqualStr(hmac(payload), sig)) return fail(req, "invalid_state");
  const saved = JSON.parse(Buffer.from(payload, "base64url").toString()) as { state: string; nonce: string; verifier: string; returnTo: string; iat: number };
  if (!timingSafeEqualStr(saved.state, state) || Date.now() - saved.iat > 600_000) return fail(req, "invalid_state");

  try {
    const result = await msalClient(cfg).acquireTokenByCode({
      code, scopes: ENTRA_SCOPES, redirectUri: redirectUri(cfg), codeVerifier: saved.verifier,
    });
    const claims = (result?.idTokenClaims ?? {}) as Record<string, string | undefined>;
    if (claims.tid !== cfg.tenantId) return fail(req, "wrong_tenant");
    if (claims.nonce !== saved.nonce) return fail(req, "invalid_nonce");
    const oid = claims.oid;
    const email = (claims.email ?? claims.preferred_username ?? "").toLowerCase();
    if (!oid || !email) return fail(req, "missing_claims");

    const graph = result?.accessToken ? await fetchGraphProfile(result.accessToken) : {};
    const userId = await provisionEntraUser({
      oid, tenantId: claims.tid, email,
      displayName: claims.name ?? email,
      givenName: graph.givenName ?? claims.given_name ?? null,
      surname: graph.surname ?? claims.family_name ?? null,
      jobTitle: graph.jobTitle, department: graph.department, employeeId: graph.employeeId, mobilePhone: graph.mobilePhone,
    });
    // "amr" lists how Microsoft authenticated the person; "mfa" means Microsoft already did the second step.
    const amr = (result?.idTokenClaims as { amr?: unknown } | undefined)?.amr;
    await createSession(userId, "entra", Array.isArray(amr) && amr.includes("mfa"));
    return NextResponse.redirect(new URL(saved.returnTo || "/home", req.url));
  } catch (err) {
    if (err instanceof DomainError) return fail(req, err.message);
    console.error("[auth] Entra callback failed", err);
    return fail(req, "sso_failed");
  }
}
