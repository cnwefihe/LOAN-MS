import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listReleases } from "@/server/services/releases";
import { Card, PageHeader, DateText, Badge } from "@/components/ui";

export const metadata = { title: "Recent updates" };

export default async function WhatsNew() {
  await requireActor();
  const rows = await listReleases(await getDb());
  return (
    <>
      <PageHeader title="Recent updates" description="Changes to the Loan Management System, by version." crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Recent updates" }]} />
      <Card>
        <ol className="space-y-6">
          {rows.map(({ r }, i) => (
            <li key={r.id} className="border-l-2 border-brand-200 pl-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                Version {r.version} {i === 0 && <Badge tone="brand">Current</Badge>}
                <span className="font-normal text-muted"><DateText value={r.publishedAt} /></span>
              </p>
              <p className="mt-0.5 font-medium">{r.title}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                {r.notes.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => <li key={l}>{l.replace(/^[-*]\s*/, "")}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
