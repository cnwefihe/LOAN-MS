import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { getStaffRecord, getObligations } from "@/server/services/staff";
import { latestPayslip } from "@/server/services/payslips";
import { payslipDetailsBadge } from "@/components/payslip-details";
import { payslipMonth } from "@/components/payslip-breakdown";
import { guarantorExposure } from "@/server/services/guarantors";
import { type RoleCode } from "@/lib/auth/permissions";
import { getWording } from "@/server/wording";
import { Download, LifeBuoy, Mail, Monitor, ShieldCheck } from "lucide-react";
import { getSettings } from "@/server/settings";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, KeyValues, Money, PageHeader, DateText } from "@/components/ui";
import { updateProfileAction, updatePayslipDetailsAction } from "@/app/actions/applicant";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "My profile" };

export default async function Profile() {
  const actor = await requireActor("profile.view_own");
  const db = await getDb();
  const w = await getWording(db);
  const rec = await getStaffRecord(db, actor.userId);
  const [mfaRow] = await (await getDb()).select({ enabledAt: users.mfaEnabledAt, codes: users.mfaRecoveryHashes }).from(users).where(eq(users.id, actor.userId));
  const mfa = { enabledAt: mfaRow?.enabledAt ?? null, codesLeft: mfaRow?.codes?.length ?? 0 };
  const ob = await getObligations(db, actor.userId);
  const exp = await guarantorExposure(db, actor.userId);
  const p = rec.profile;
  const slip = await latestPayslip(db, actor.userId);
  const contact = await getSettings(db, ["org.hrEmail", "org.hrPhone", "org.ictEmail", "privacy.dpoEmail"]);
  return (
    <>
      <PageHeader title="My profile" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Profile" }]}
        description={`Signed in as ${rec.user.email}`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="My details" description="Exactly as printed on your payslip."
            actions={payslipDetailsBadge(p)}>
            <ActionForm action={updatePayslipDetailsAction} submitLabel="Save">
              <div className="grid gap-4 sm:grid-cols-3">
                <div><label htmlFor="payslipName" className="label">Name</label><input id="payslipName" name="payslipName" required maxLength={200} defaultValue={p?.payslipName || rec.user.displayName} className="input" /></div>
                <div><label htmlFor="staffNumber" className="label">Employee code</label><input id="staffNumber" name="staffNumber" required maxLength={40} defaultValue={p?.staffNumber ?? ""} className="input" /></div>
                <div><label htmlFor="payGrade" className="label">Pay grade</label><input id="payGrade" name="payGrade" required maxLength={120} defaultValue={p?.payGrade ?? ""} className="input" /></div>
              </div>
              <p className="hint mt-2">You can upload your payslip as soon as these are saved. Human Resources then confirms them against your personnel record.</p>
            </ActionForm>
            <div className="mt-6 border-t border-line pt-5">
              <p className="mb-3 text-xs text-muted">From your Human Resources record. Contact Human Resources if any of these are wrong.</p>
              {!p?.employmentStatus && <div className="mb-4"><Alert tone="info">Human Resources has not yet completed your employment record; it will be checked when you apply.</Alert></div>}
              <KeyValues columns={3} items={[
                ["Department", rec.department?.name], ["School / faculty", rec.school?.name],
                ["Designation", p?.designation], ["Staff category", rec.category?.name], ["Employment status", p?.employmentStatus ? p.employmentStatus.charAt(0).toUpperCase() + p.employmentStatus.slice(1).replace("_", " ") : undefined],
                ["Employment date", <DateText key="e" value={p?.employmentDate} />], ["Length of service", `${monthsText(rec.serviceMonths)}`],
                ["Latest payslip", slip ? <a key="s" href="/eligibility" className="link">{payslipMonth(slip.period)}</a> : <a key="s" href="/eligibility" className="link">Upload</a>],
                ["Roles", <span key="r" className="flex flex-wrap gap-1">{actor.roles.map((r) => <Badge key={r}>{w.role[r as RoleCode]?.name ?? r}</Badge>)}</span>],
              ]} />
            </div>
          </Card>
          <Card className="flex-1" title="Contact and bank details" description="Used by the Accounts Payable Officer to pay your loan or advance into your account.">
            <ActionForm action={updateProfileAction} submitLabel="Save">
              <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
                <fieldset className="space-y-4">
                  <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Contact</legend>
                  <div><label htmlFor="phone" className="label">Phone</label><input id="phone" name="phone" defaultValue={p?.phone ?? ""} autoComplete="tel" className="input" /></div>
                  <div><label htmlFor="residentialAddress" className="label">Residential address</label><input id="residentialAddress" name="residentialAddress" defaultValue={p?.residentialAddress ?? ""} autoComplete="street-address" maxLength={300} className="input" /></div>
                </fieldset>
                <fieldset className="space-y-4">
                  <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Bank account</legend>
                  <div><label htmlFor="bankName" className="label">Bank</label><input id="bankName" name="bankName" defaultValue={p?.bankName ?? ""} className="input" /></div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor="bankAccountName" className="label">Account name</label><input id="bankAccountName" name="bankAccountName" defaultValue={p?.bankAccountName ?? ""} className="input" /></div>
                    <div><label htmlFor="bankAccountNumber" className="label">Account number</label><input id="bankAccountNumber" name="bankAccountNumber" inputMode="numeric" pattern="\d{10}" placeholder={p?.bankAccountLast4 ? `•••••• ${p.bankAccountLast4}` : "10 digits"} className="input" aria-describedby="acct-hint" /></div>
                  </div>
                  <p id="acct-hint" className="hint">Leave blank to use your saved salary account, or enter a different 10-digit account number.</p>
                </fieldset>
              </div>
            </ActionForm>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card title="Loans and guarantees" description="Your own figures only.">
            <KeyValues columns={2} items={[
              ["Active loans", ob.liveLoanCount], ["Applications in progress", ob.inFlightApplications],
              ["Monthly instalments", <Money key="d" value={ob.monthlyDeductions} />], ["Outstanding balance", <Money key="o" value={ob.outstanding} />],
              ["Loans you guarantee", exp.liveCount], ["Amount you guarantee", <Money key="t" value={exp.total} />],
            ]} />
            <p className="hint mt-3">Amount you guarantee: your share of colleagues' loans that you could be asked to repay if they do not.</p>
          </Card>
          <Card title="Two-step verification" description={mfa.enabledAt ? "On" : "Off"}>
            {mfa.enabledAt
              ? <p className="text-sm">Set up on <DateText value={mfa.enabledAt} />. You enter a code from your authenticator app when you sign in. {mfa.codesLeft} recovery codes left.</p>
              : <><p className="text-sm">For additional security, confirm each sign-in with a code from an authenticator app on your phone.</p><a href="/mfa?setup=1" className="btn-secondary mt-3">Set up</a></>}
          </Card>
          <Card className="flex-1" title="Privacy and help" description="Your details are used only for your loans and advances, and seen only by staff whose role requires it." bodyClassName="p-0!">
            <ul className="divide-y divide-line">
              {[
                { href: "/privacy", icon: ShieldCheck, title: "Privacy notice", text: "How your data is used, and your rights under the Nigeria Data Protection Act 2023." },
                { href: "/api/me/export", icon: Download, title: "Download my data", text: "A PDF of every record held about you." },
                { href: `mailto:${contact["privacy.dpoEmail"]}`, icon: Mail, title: "Data Protection Officer", text: contact["privacy.dpoEmail"] },
                { href: `mailto:${contact["org.hrEmail"]}`, icon: LifeBuoy, title: "Help with a loan", text: `Human Resources, ${contact["org.hrEmail"]}${contact["org.hrPhone"] ? `, ${contact["org.hrPhone"]}` : ""}` },
                { href: `mailto:${contact["org.ictEmail"]}`, icon: Monitor, title: "ICT Support", text: contact["org.ictEmail"] },
              ].map((x) => (
                <li key={x.title}>
                  <a href={x.href} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                    <x.icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-navy" />
                    <span className="min-w-0"><span className="block text-sm font-medium text-ink">{x.title}</span><span className="block break-words text-xs text-muted">{x.text}</span></span>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
