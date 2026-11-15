import { getSetting } from "@/server/settings";
import { durationText } from "@/lib/duration";
import { desc, eq, isNull, and } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { getTransport } from "@/server/email";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, EmptyState, PageHeader, DateText, Stat, StatGrid, Table, Th, Td } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { runServicingAction } from "@/app/actions/accounts";

export const metadata = { title: "Automation" };

const STEPS = [
  "Updates every loan's balance and days overdue, and marks loans overdue or defaulted.",
  "Reminds borrowers before an instalment is due.",
  "Reminds guarantors, approvers and staff about work left waiting, and alerts administrators about long delays.",
  "Clears out old notifications and expired sign-ins.",
];

interface RunCounts { checked?: number; changes?: string[]; reminders?: number; guarantorReminders?: number; workReminders?: number; escalations?: number }

export default async function DailyCheck({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  await requireActor("servicing.run");
  const sp = await searchParams;
  const db = await getDb();
  const servicing = eq(auditLogs.action, "servicing.run");
  const runs = await db.select({ log: auditLogs, runBy: users.displayName }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(servicing).orderBy(desc(auditLogs.id)).limit(1000);
  const [automatic] = await db.select({ at: auditLogs.createdAt }).from(auditLogs).where(and(servicing, isNull(auditLogs.actorId))).orderBy(desc(auditLogs.id)).limit(1);
  const checkEvery = await getSetting(db, "automation.checkEveryMinutes");
  const pg = paginate(runs, sp.page, sp.size);
  const emailReady = !!getTransport();
  const last = runs[0];
  const counts = (r: typeof runs[number]) => (r.log.after ?? {}) as RunCounts;
  const reminders = (c: RunCounts) => (c.reminders === undefined ? undefined : c.reminders + (c.guarantorReminders ?? 0) + (c.workReminders ?? 0) + (c.escalations ?? 0));
  const lastCounts = last ? counts(last) : undefined;

  return (
    <>
      <PageHeader title="Automation" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Automation" }]}
        description="Keeps every loan up to date and sends reminders." />
      {!emailReady && <div className="mb-6"><Alert tone="warning" title="Email is not set up">People see notifications in the app, but no emails are sent.</Alert></div>}
      <StatGrid>
        <Stat label="Last check" value={last ? <DateText value={last.log.createdAt} /> : "None yet"} hint={last ? `By ${last.runBy ?? "the system"}` : "Run the first check below"} />
        <Stat label="Last automatic check" value={automatic ? <DateText value={automatic.at} /> : "None yet"} hint={`Runs every ${durationText(checkEvery)}`} tone={automatic ? "default" : "warning"} />
        <Stat label="Loans checked" value={lastCounts?.checked ?? "N/A"} hint="In the last check" />
        <Stat label="Reminders" value={lastCounts ? reminders(lastCounts) ?? "N/A" : "N/A"} hint="In the last check" />
      </StatGrid>
      <Card title="What the check does" className="mb-6">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{STEPS.map((s) => <li key={s}>{s}</li>)}</ul>
        <p className="mt-3 text-sm text-muted">It is safe to run more than once in a day: nobody is reminded twice for the same thing.</p>
        <div className="mt-4 border-t border-line pt-4">
          <ActionForm action={runServicingAction} submitLabel="Run check now">
            {emailReady && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="dispatch" defaultChecked /> Also send emails waiting in the queue</label>}
          </ActionForm>
        </div>
      </Card>
      <Card title="Past checks" bodyClassName={runs.length ? "p-5 pt-0" : undefined}>
        {runs.length ? (
          <>
            <Table caption="Past checks">
              <thead><tr><Th>When</Th><Th>Run by</Th><Th right>Loans checked</Th><Th right>Status changes</Th><Th right>Reminders</Th></tr></thead>
              <tbody>{pg.items.map((r) => {
                const c = counts(r);
                return (
                  <tr key={r.log.id}>
                    <Td><DateText value={r.log.createdAt} withTime /></Td>
                    <Td>{r.runBy ?? "System"}</Td>
                    <Td right>{c.checked ?? "N/A"}</Td>
                    <Td right>{c.changes?.length ?? "N/A"}</Td>
                    <Td right>{reminders(c) ?? "N/A"}</Td>
                  </tr>
                );
              })}</tbody>
            </Table>
            <Pagination data={pg} base="/accounts/servicing" label="checks" />
          </>
        ) : <EmptyState title="No checks yet" description="Each check will be listed here." />}
      </Card>
    </>
  );
}
