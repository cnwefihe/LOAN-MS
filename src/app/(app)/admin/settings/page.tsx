import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { SETTINGS, SETTING_GROUPS, getSettings, type SettingKey } from "@/server/settings";
import { Card, PageHeader } from "@/components/ui";
import { SettingsGroupForm } from "@/components/settings-form";

export const metadata = { title: "System settings" };

const ON_BRANDING_PAGE = new Set<string>(["Organisation and branding", "Documents"]);
const GROUPS = SETTING_GROUPS.filter((g) => !ON_BRANDING_PAGE.has(g));
const DESCRIPTIONS: Record<string, string> = {
  Workflow: "How applications move between Human Resources and approvers.",
  "Workflow wording": "Names shown on queues, trackers, documents and menus.",
  "Lending rules": "Limits on borrowing and guaranteeing.",
  Reminders: "Timed from when work reaches the person who must act.",
  Automation: "How often the loan check runs: deductions, overdue loans, reminders and tidying.",
  "Financial controls": "Which transactions need the Bursar's authorisation.",
  Security: "Sign-out and two-step verification.",
  Notifications: "In-app notifications are always recorded; these control email.",
  "Data retention": "Old operational records are removed; financial and audit records stay.",
  Privacy: "Contact details shown in the privacy notice.",
  Announcements: "A banner at the top of every page. Leave it empty to hide it.",
};

export default async function Settings({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  await requireActor("admin.settings.manage");
  const { section } = await searchParams;
  const active = GROUPS.find((g) => g === section) ?? GROUPS[0];
  const values = await getSettings(await getDb(), Object.keys(SETTINGS) as SettingKey[]);
  return (
    <>
      <PageHeader title="System settings" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Settings" }]}
        description={<>How the system behaves. Logos and document markings are under <Link href="/admin/branding" className="link">Branding</Link>.</>} />
      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {GROUPS.map((g) => (
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
          <SettingsGroupForm group={active} values={values} />
        </Card>
      </div>
    </>
  );
}
