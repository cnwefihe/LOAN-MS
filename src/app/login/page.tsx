import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getSignInState, devLoginEnabled } from "@/lib/auth/session";
import { entraConfig } from "@/lib/auth/entra";
import { FIXTURE_USERS } from "@/server/seed";
import { getBranding, logoUrl } from "@/server/branding";
import { currentVersion } from "@/server/services/releases";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  sso_not_configured: "Microsoft sign-in has not been configured for this environment yet. Contact ICT Services.",
  sso_denied: "Sign-in was cancelled or denied by Microsoft.",
  invalid_state: "Your sign-in attempt expired or could not be verified. Please try again.",
  invalid_nonce: "Your sign-in response could not be verified. Please try again.",
  wrong_tenant: "Please sign in with your institutional Microsoft 365 account.",
  missing_claims: "Your Microsoft account did not provide the required identity information.",
  sso_failed: "Sign-in failed. Please try again; if it persists, contact ICT Services.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes.",
  unknown_fixture: "Unknown development account.",
};

function MicrosoftLogo() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; signedOut?: string; returnTo?: string }> }) {
  const state = await getSignInState();
  if (state) redirect(state.mfaPending ? "/mfa" : "/dashboard");
  const sp = await searchParams;
  const sso = entraConfig();
  const brand = await getBranding(await getDb());
  const version = await currentVersion(await getDb());
  const dev = devLoginEnabled();
  let fixtures: { id: string; displayName: string; email: string }[] = [];
  if (dev) {
    const db = await getDb();
    fixtures = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(and(eq(users.isDevFixture, true), eq(users.isActive, true))).orderBy(users.displayName);
  }
  const error = sp.error ? ERRORS[sp.error] ?? decodeURIComponent(sp.error) : null;
  const loginHref = `/api/auth/login${sp.returnTo ? `?returnTo=${encodeURIComponent(sp.returnTo)}` : ""}`;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="h-1.5 bg-navy" aria-hidden />
      <main id="main" className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        {/* Same size as the two-step verification card. */}
        <div className="flex min-h-[30.5rem] w-full max-w-sm flex-col justify-center rounded-lg border border-line bg-white px-8 py-8 shadow-sm">
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl(brand, "logo")} alt={brand.institutionName} className="mx-auto h-16 w-auto" />
            <h1 className="mt-6 text-xl font-semibold text-navy">{brand.systemName}</h1>
            <p className="mt-1 text-sm text-muted">Staff sign-in</p>
          </div>

          {sp.signedOut && <p role="status" className="mt-6 rounded-md border border-green-200 bg-success-50 px-3 py-2 text-sm text-green-900">{sp.signedOut === "idle" ? "You were signed out because you were inactive. Sign in to continue." : "You have been signed out."}</p>}
          {error && <p role="alert" className="mt-6 rounded-md border border-red-200 bg-danger-50 px-3 py-2 text-sm text-red-900">{error}</p>}

          {sso ? (
            <a href={loginHref} className="mt-7 flex w-full items-center justify-center gap-3 rounded-md bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
              <MicrosoftLogo /> Sign in with Microsoft
            </a>
          ) : (
            <button type="button" disabled className="mt-7 flex w-full cursor-not-allowed items-center justify-center gap-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-muted">
              <MicrosoftLogo /> Sign in with Microsoft
            </button>
          )}
          {!sso && <p className="mt-2 text-center text-xs text-warning-ink">Microsoft sign-in is not yet configured.</p>}
        </div>

        {dev && (
          <section className="mt-6 w-full max-w-2xl rounded-lg border border-amber-300 bg-warning-50 p-4" aria-labelledby="dev-title">
            <h2 id="dev-title" className="text-sm font-semibold text-warning-ink">Test accounts (development only)</h2>
            <p className="mt-0.5 text-xs text-warning-ink">Fictional users. Not available in production.</p>
            {fixtures.length === 0 ? (
              <p className="mt-3 text-xs text-warning-ink">No test accounts found. Run <code>npm run db:seed -- --fixtures</code>.</p>
            ) : (
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {fixtures.map((f) => {
                  const meta = FIXTURE_USERS.find((x) => x.email === f.email);
                  return (
                    <li key={f.id}>
                      <form action="/api/auth/dev-login" method="post">
                        <input type="hidden" name="userId" value={f.id} />
                        <button className="flex w-full items-center justify-between gap-2 rounded-md border border-amber-200 bg-white px-3 py-1.5 text-left text-sm hover:border-brand">
                          <span className="font-medium">{f.displayName}</span>
                          <span className="truncate text-xs text-muted">{meta?.label ?? "Applicant"}</span>
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </main>
      <footer className="app-footer shrink-0 px-4 py-1.5 text-center leading-tight">
        <p className="text-[0.8125rem] font-semibold text-navy">&copy; {new Date().getFullYear()} {brand.institutionName}. All rights reserved.</p>
        <p className="text-[0.8125rem] font-medium text-slate-700">{brand.systemName} v{version}</p>
      </footer>
    </div>
  );
}
