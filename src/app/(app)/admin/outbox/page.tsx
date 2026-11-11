import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { emailOutboxList } from "@/server/services/admin";
import { emailStatus } from "@/server/email";
import { Alert, Card, EmptyState, PageHeader, DateText, Stat, StatGrid, StatusBadge, Table, Tabs, Th, Td } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { SearchFilter } from "@/components/search-filter";
import { can } from "@/server/actor";
import { dispatchEmailsAction, requeueEmailsAction, sendTestEmailAction } from "@/app/actions/admin";
import { paginate, Pagination } from "@/components/pagination";

export const metadata = { title: "Emails" };

export default async function Emails({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("admin.audit.view");
  const rows = await emailOutboxList(await getDb(), actor);
  const sp = await searchParams;
  const canSend = can(actor, "admin.settings.manage");
  const tab = sp.tab === "test" && canSend ? "test" : "emails";
  const needle = sp.q?.trim().toLowerCase();
  const pg = paginate(needle ? rows.filter((r) => `${r.toAddress} ${r.subject}`.toLowerCase().includes(needle)) : rows, sp.page, sp.size);
  const status = emailStatus();
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return (
    <>
      <PageHeader title="Emails" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Emails" }]} description="Outgoing emails and their delivery status."
        actions={<>
          <ActionForm inline action={dispatchEmailsAction} submitLabel="Send queued" submitClassName="btn-secondary h-8 px-3 text-xs" confirm="Send the queued emails now?" />
          {canSend && <ActionForm inline action={requeueEmailsAction} submitLabel="Retry failed" submitClassName="btn-primary h-8 px-3 text-xs" confirm="Re-queue failed and unsent emails from the last 14 days and send them?" />}
        </>} />
      <div className="mb-6">
        <Alert tone={status.configured ? "success" : "warning"} title={status.configured ? "Email delivery is configured" : "Email delivery is not configured"}>
          {status.configured ? status.detail : "Emails are recorded but not sent. They can be retried once Microsoft 365 is connected."}
        </Alert>
      </div>
      <StatGrid>
        <Stat label="Queued" value={count("queued")} />
        <Stat label="Sent" value={count("sent")} tone="success" />
        <Stat label="Failed" value={count("failed")} tone={count("failed") ? "danger" : "default"} />
        <Stat label="Not sent" value={count("not_configured")} tone={count("not_configured") ? "warning" : "default"} />
      </StatGrid>
      {canSend && <Tabs base="/admin/outbox" active={tab} tabs={[{ key: "emails", label: "Emails", count: rows.length }, { key: "test", label: "Test email" }]} />}
      {tab === "test" ? (
        <Card className="max-w-2xl" title="Send a test email" description="Send a sample message to confirm delivery.">
          <ActionForm action={sendTestEmailAction} submitLabel="Send test email" confirm="Send a test email to this address?">
            <label htmlFor="to" className="label">Recipient</label>
            <input id="to" name="to" type="email" required defaultValue={actor.email} className="input" />
          </ActionForm>
        </Card>
      ) : (
        <Card bodyClassName="p-5">
          <SearchFilter q={sp.q} placeholder="Search recipient or subject" />
          {pg.items.length === 0 ? <EmptyState title="No emails found" description={rows.length ? "Try a different search." : "Emails appear here once the system sends them."} /> : (
            <Table caption="Emails">
              <thead><tr><Th>Queued</Th><Th>To</Th><Th>Subject</Th><Th>Status</Th><Th right>Attempts</Th></tr></thead>
              <tbody>
                {pg.items.map((r) => (
                  <tr key={r.id}>
                    <Td><DateText value={r.createdAt} withTime /></Td>
                    <Td>{r.toAddress}</Td>
                    <Td className="max-w-sm truncate" >{r.subject}</Td>
                    <Td><span title={r.lastError ?? undefined}><StatusBadge status={r.status} /></span></Td>
                    <Td right>{r.attempts}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination data={pg} base="/admin/outbox" params={{ q: sp.q }} label="emails" />
        </Card>
      )}
    </>
  );
}
