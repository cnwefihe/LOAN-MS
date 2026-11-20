import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSignInState } from "@/lib/auth/session";
import { getBranding, logoUrl } from "@/server/branding";
import { beginEnrolment, devFixtureCode } from "@/server/services/mfa";
import { ActionForm } from "@/components/action-form";
import { SignInAssistant } from "@/components/sign-in-assistant";
import { confirmMfaSetupAction, verifyMfaAction } from "@/app/actions/mfa";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-step verification" };

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ setup?: string }> }) {
  const state = await getSignInState();
  if (!state) redirect("/login");
  const sp = await searchParams;
  const setupWanted = !state.mfaEnrolled && (state.mfaPending || sp.setup === "1");
  if (!state.mfaPending && !setupWanted) redirect("/dashboard");
  const db = await getDb();
  const brand = await getBranding(db);
  const setup = setupWanted ? await beginEnrolment(db, state.actor.userId, `${brand.shortName} LMS`) : null;
  const devCode = await devFixtureCode(db, state.actor.userId);

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="h-1.5 bg-navy" aria-hidden />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className={`w-full rounded-lg border border-line bg-white px-8 py-8 shadow-sm ${setup ? "max-w-2xl" : "max-w-sm"}`}>
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl(brand, "logo")} alt={brand.institutionName} className="mx-auto h-12 w-auto" />
            <h1 className="mt-5 text-lg font-semibold text-navy">{setup ? "Set up two-step verification" : "Two-step verification"}</h1>
            <p className="mt-1 text-sm text-muted">{setup ? "Required by the University. Protects loan, payment and staff records." : `Enter the six-digit code from your authenticator app, ${state.actor.displayName.split(" ")[0]}.`}</p>
          </div>

          {setup ? (
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <ol className="space-y-4 text-sm">
                <li><span className="font-semibold">1. Install an authenticator app</span><br /><span className="text-muted">Microsoft Authenticator is recommended.</span></li>
                <li>
                  <span className="font-semibold">2. Scan this code with the app</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={setup.qr} alt="QR code for your authenticator app" className="mt-2 h-44 w-44 rounded border border-line" />
                  <span className="mt-2 block text-xs text-muted">Cannot scan? Enter this key:</span>
                  <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 text-xs">{setup.secret.match(/.{1,4}/g)!.join(" ")}</code>
                </li>
              </ol>
              <div className="space-y-4 text-sm">
                <div>
                  <span className="font-semibold">3. Keep your recovery codes</span>
                  <p className="text-xs text-muted">Each code works once if you lose your phone. Store them safely.</p>
                  <ul className="mt-2 grid grid-cols-2 gap-1 rounded border border-line bg-slate-50 p-2 font-mono text-xs">
                    {setup.recoveryCodes.map((c) => <li key={c}>{c}</li>)}
                  </ul>
                </div>
                <div>
                  <span className="font-semibold">4. Enter the code shown in the app</span>
                  <ActionForm action={confirmMfaSetupAction} submitLabel="Verify and continue" className="mt-2">
                    <label htmlFor="code" className="sr-only">Six-digit code</label>
                    <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required placeholder="123456" className="input text-center text-lg tracking-[0.4em]" />
                  </ActionForm>
                </div>
              </div>
            </div>
          ) : (
            <ActionForm action={verifyMfaAction} submitLabel="Verify" className="mt-6">
              <label htmlFor="code" className="label">Code</label>
              <input id="code" name="code" autoComplete="one-time-code" required maxLength={12} placeholder="123456" className="input text-center text-lg tracking-[0.3em]" />
              <p className="text-xs text-muted">Lost your phone? Enter one of your recovery codes instead.</p>
            </ActionForm>
          )}

          {devCode && (
            <p className="mt-5 rounded-md border border-amber-300 bg-warning-50 px-3 py-2 text-center text-xs text-warning-ink">
              Test account (development only). Current code: <strong data-testid="dev-mfa-code" className="font-mono text-sm">{devCode}</strong>
            </p>
          )}
          <form action="/api/auth/logout" method="post" className="mt-5 text-center">
            <button className="text-xs text-muted hover:text-ink hover:underline">Sign out</button>
          </form>
        </div>
      </main>
      <SignInAssistant />
    </div>
  );
}
