/**
 * Microsoft Entra ID (Azure AD) single sign-on: OpenID Connect authorization-code flow with PKCE,
 * using Microsoft's official MSAL library as a confidential client.
 *
 * Required configuration (see .env.example):
 *   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, APP_BASE_URL
 * App registration: redirect URI  {APP_BASE_URL}/api/auth/callback  (Web platform),
 *   delegated Graph permission User.Read; single-tenant (PAU tenant only).
 */
import { ConfidentialClientApplication, CryptoProvider, type Configuration } from "@azure/msal-node";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export function entraConfig(): EntraConfig | null {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const baseUrl = process.env.APP_BASE_URL;
  if (!tenantId || !clientId || !clientSecret || !baseUrl) return null;
  return { tenantId, clientId, clientSecret, baseUrl: baseUrl.replace(/\/$/, "") };
}

export const ENTRA_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read"];

let cached: { key: string; app: ConfidentialClientApplication } | null = null;

export function msalClient(cfg: EntraConfig): ConfidentialClientApplication {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  if (cached?.key === key) return cached.app;
  const conf: Configuration = {
    auth: {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      // Tenant-specific authority: only accounts from the PAU tenant can sign in.
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    },
  };
  cached = { key, app: new ConfidentialClientApplication(conf) };
  return cached.app;
}

export const cryptoProvider = new CryptoProvider();

export function redirectUri(cfg: EntraConfig): string {
  return `${cfg.baseUrl}/api/auth/callback`;
}

export interface GraphProfile {
  jobTitle?: string | null;
  department?: string | null;
  employeeId?: string | null;
  mobilePhone?: string | null;
  givenName?: string | null;
  surname?: string | null;
}

/** Best-effort directory enrichment. Failure must never block sign-in. */
export async function fetchGraphProfile(accessToken: string): Promise<GraphProfile> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=jobTitle,department,employeeId,mobilePhone,givenName,surname", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {};
    return (await res.json()) as GraphProfile;
  } catch {
    return {};
  }
}
