import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { GROUP_PERMISSION, SETTINGS, SETTING_GROUPS, getSettings, type SettingKey } from "@/server/settings";
import { can } from "@/server/actor";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { schools } from "@/db/schema";
import { ActionForm } from "@/components/action-form";
import { setSchoolRepaymentAccountAction } from "@/app/actions/admin";
import { SettingsGroupForm } from "@/components/settings-form";

export const metadata = { title: "System settings" };

const ON_BRANDING_PAGE = new Set<string>(["Organisation and branding", "Documents"]);
const GROUPS = SETTING_GROUPS.filter((g) => !ON_BRANDING_PAGE.has(g));
const DESCRIPTIONS: Record<string, string> = {
  Workflow: "How applications move between Human Resources and approvers.",
  "School accounts": "The account each school's staff pay into when they repay a loan early. Staff see their own school's account.",
  "Workflow wording": "Names shown on queues, trackers, documents and menus.",
  "Lending rules": "Limits on borrowing and guaranteeing.",
  Reminders: "Timed from when work reaches the person who must act.",
  Automation: "How often the loan check runs: deductions, overdue loans, reminders and tidying.",
  "Financial controls": "Which transactions need the Bursar's authorisation.",
  Security: "Each limit is separate: sign-out times, sessions at the same time, the slider check, wrong two-step codes, the Register and requests to ICT support.",
  Notifications: "In-app notifications are always recorded; these control email.",
  "Data retention": "Old operational records are removed; financial and audit records stay.",
  Privacy: "Contact details shown in the privacy notice.",
  Announcements: "A banner at the top of every page. Leave it empty to hide it.",
};

export default async function Settings({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const actor = await requireActor("admin.settings.manage", "settings.lending", "settings.school_accounts", "settings.security");
  const { section } = await searchParams;
  // Each person sees the groups their permissions let them change.
  const groups = GROUPS.filter((g) => can(actor, GROUP_PERMISSION[g]));
  const active = groups.find((g) => g === section) ?? groups[0];
  const db = await getDb();
  const values = await getSettings(db, Object.keys(SETTINGS) as SettingKey[]);
  const schoolList = active === "School accounts" ? await db.select().from(schools).orderBy(schools.name) : [];
  return (
    <>
      <PageHeader title="System settings" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Settings" }]}
        description={can(actor, "admin.branding.manage") ? <>How the system behaves. Logos and document markings are under <Link href="/admin/branding" className="link">Branding</Link>.</> : "How the system behaves."} />
      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {groups.map((g) => (
              <li key={g} className="shrink-0">
                <Link href={`/admin/settings?section=${encodeURIComponent(g)}`} aria-current={g === active ? "page" : undefined}
                  className={`block rounded-md px-3 py-2 text-sm ${g === active ? "bg-white font-medium text-brand shadow-sm ring-1 ring-line" : "text-muted hover:bg-white hover:text-ink"}`}>{g}</Link>
              </li>
            ))}
          </ul>
        </nav>
        {/* Keyed so a change of section shows that section's saved values. */}
        <Card key={active} title={active} description={active === "Privacy"
          ? <>The contact shown in the privacy notice. To change the notice itself, go to <Link href="/admin/content/terms/privacy_notice" className="link">Templates &gt; Privacy notice</Link>.</>
          : DESCRIPTIONS[active]}>
          {active === "School accounts" ? (
            schoolList.length === 0 ? <EmptyState title="No schools yet" description="Add schools under Organisation first." /> : (
              <ul className="divide-y divide-line">
                {schoolList.map((sc) => (
                  <li key={sc.id} className="py-4 first:pt-0 last:pb-0">
                    <h3 className="text-sm font-semibold text-navy">{sc.name}{!sc.earlyRepaymentAccountNumber && <span className="ml-2 text-xs font-normal text-warning-ink">Not set</span>}</h3>
                    <ActionForm action={setSchoolRepaymentAccountAction.bind(null, sc.id)} submitLabel="Save" variant="secondary" listChanges>
                      <div className="mt-2 grid gap-3 sm:grid-cols-3">
                        <div><label htmlFor={`bank-${sc.id}`} className="label">Bank</label><input id={`bank-${sc.id}`} name="bank" maxLength={100} defaultValue={sc.earlyRepaymentBank ?? ""} className="input" /></div>
                        <div><label htmlFor={`name-${sc.id}`} className="label">Account name</label><input id={`name-${sc.id}`} name="accountName" maxLength={150} defaultValue={sc.earlyRepaymentAccountName ?? ""} className="input" /></div>
                        <div><label htmlFor={`number-${sc.id}`} className="label">Account number</label><input id={`number-${sc.id}`} name="accountNumber" inputMode="numeric" pattern="\d{10}" maxLength={10} defaultValue={sc.earlyRepaymentAccountNumber ?? ""} className="input" /></div>
                      </div>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )
          ) : <SettingsGroupForm group={active} values={values} />}
        </Card>
      </div>
    </>
  );
}
