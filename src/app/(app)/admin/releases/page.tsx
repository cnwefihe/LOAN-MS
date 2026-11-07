import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listReleases, currentVersion } from "@/server/services/releases";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, DateText, Badge } from "@/components/ui";
import { publishReleaseAction } from "@/app/actions/admin";

export const metadata = { title: "Version updates" };

export default async function Releases() {
  await requireActor("admin.settings.manage");
  const db = await getDb();
  const [rows, current] = await Promise.all([listReleases(db), currentVersion(db)]);
  return (
    <>
      <PageHeader title="Version updates" description={`Current version ${current}. Publishing notifies all staff.`} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Version updates" }]} />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Publish an update" className="lg:col-span-2">
          <ActionForm action={publishReleaseAction} submitLabel="Publish" confirm="Publish this version and notify all staff?">
            <div>
              <label htmlFor="version" className="label">Version</label>
              <input id="version" name="version" required placeholder="e.g. 1.1" pattern="[vV]?\d{1,3}\.\d{1,3}(\.\d{1,3})?" className="input" />
            </div>
            <div>
              <label htmlFor="title" className="label">Title</label>
              <input id="title" name="title" required maxLength={120} placeholder="e.g. Faster repayment confirmation" className="input" />
            </div>
            <div>
              <label htmlFor="notes" className="label">What has changed</label>
              <textarea id="notes" name="notes" required minLength={10} rows={6} placeholder={"One change per line, for example:\nRepayment receipts now show the balance after payment.\nReports can be filtered by date."} className="input" />
            </div>
          </ActionForm>
        </Card>
        <Card title="Release history" className="lg:col-span-3">
          <ol className="space-y-5">
            {rows.map(({ r, by }, i) => (
              <li key={r.id} className="border-l-2 border-brand-200 pl-4">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  Version {r.version} {i === 0 && <Badge tone="brand">Current</Badge>}
                  <span className="font-normal text-muted"><DateText value={r.publishedAt} />{by ? `, ${by}` : ""}</span>
                </p>
                <p className="mt-0.5 text-sm font-medium">{r.title}</p>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{r.notes}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
