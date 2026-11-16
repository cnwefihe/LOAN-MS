import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { queryAudit, documentAccessLog, activeSessions } from "@/server/services/admin";
import { DOCUMENT_CATEGORIES } from "@/server/services/documents";
import { SETTINGS, type SettingKey } from "@/server/settings";
import { activityName, areaName, deviceName } from "@/lib/activity";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, PageHeader, DateText, MENU_ACTION, MENU_FORM, Table, Th, Td, Tabs, Badge } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";
import { ReportDownloads } from "@/components/report-downloads";
import { RowMenu } from "@/components/row-menu";
import { paginate, Pagination } from "@/components/pagination";
import { revokeSessionAction } from "@/app/actions/admin";

export const metadata = { title: "Activity" };

const TYPES = ["", "loan_application", "application_guarantor", "loan_account", "financial_transaction", "disbursement", "repayment_claim", "policy_version", "user", "role", "system_setting", "document", "staff_profile", "report", "system"];

export default async function Activity({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; tab?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("admin.audit.view");
  const sp = await searchParams;
  const showSessions = can(actor, "admin.users.manage");
  const tab = sp.tab === "documents" ? "documents" : sp.tab === "sessions" && showSessions ? "sessions" : "events";
  const db = await getDb();
  const needle = sp.q?.trim().toLowerCase();
  const rows = tab === "events" ? await queryAudit(db, actor, { q: sp.q, entityType: TYPES.includes(sp.type ?? "") ? sp.type || undefined : undefined, limit: 5000 }) : [];
  const docLog = tab === "documents" ? await documentAccessLog(db, actor, sp.q) : [];
  const live = tab === "sessions" ? (await activeSessions(db, actor)).filter((r) => !needle || `${r.name} ${r.email}`.toLowerCase().includes(needle)) : [];
  const events = paginate(rows, sp.page, sp.size);
  const access = paginate(docLog, sp.page, sp.size);
  const sessions = paginate(live, sp.page, sp.size);
  const params = { q: sp.q, type: sp.type, tab: sp.tab };
  const placeholder = { events: "Search action or reference", sessions: "Search name or email", documents: "Search person or document" }[tab];
  return (
    <>
      <PageHeader title="Activity" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Activity" }]} description="Actions, sign-ins and document access. Records cannot be altered."
        actions={tab === "events" ? <ReportDownloads title="Activity" href={(f) => `/api/reports/export?report=audit&format=${f}`} /> : undefined} />
      <Tabs base="/admin/audit" active={tab} tabs={[{ key: "events", label: "Activity" }, ...(showSessions ? [{ key: "sessions", label: "Sessions" }] : []), { key: "documents", label: "Documents" }]} />
      <Card bodyClassName="p-5">
        <SearchFilter q={sp.q} hidden={{ tab }} placeholder={placeholder}
          filter={tab === "events" ? { name: "type", value: sp.type, options: TYPES.map((t) => ({ value: t, label: t ? areaName(t) : "All areas" })) } : undefined} />
        {tab === "events" && (events.items.length === 0 ? <EmptyState title="No activity found" description="Try a different search." /> : (
          <Table caption="Activity">
            <thead><tr><Th>Name</Th><Th>Action</Th><Th>Module</Th><Th>Description</Th><Th>Date and time</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {events.items.map(({ log, actorName }) => (
                <tr key={log.id}>
                  <Td className="font-medium">{actorName ?? "System"}</Td>
                  <Td>{activityName(log.action)}</Td>
                  <Td>{areaName(log.entityType)}</Td>
                  <Td className="max-w-sm truncate text-muted">{log.summary || SETTINGS[log.entityId as SettingKey]?.label || "-"}</Td>
                  <Td><DateText value={log.createdAt} withTime /></Td>
                  <Td right><RowMenu label={activityName(log.action)} items={[{ label: "View details", href: `/admin/audit/${log.id}` }]} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
        {tab === "sessions" && (sessions.items.length === 0 ? <EmptyState title="No active sessions" /> : (
          <Table caption="Active sessions">
            <thead><tr><Th>Name</Th><Th>Sign-in method</Th><Th>Device</Th><Th>IP address</Th><Th>Signed in</Th><Th>Last active</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {sessions.items.map(({ s, name }) => (
                <tr key={s.id}>
                  <Td className="font-medium">{name}</Td>
                  <Td>{s.authMethod === "entra" ? "Microsoft" : "Development"}</Td>
                  <Td>{deviceName(s.userAgent)}</Td>
                  <Td>{s.ipAddress ?? "-"}</Td>
                  <Td><DateText value={s.createdAt} withTime /></Td>
                  <Td><DateText value={s.lastSeenAt} withTime /></Td>
                  <Td right><RowMenu label={`${name}, ${deviceName(s.userAgent)}`}><ActionForm inline className={MENU_FORM} action={revokeSessionAction.bind(null, s.id)} submitLabel="Revoke session" submitClassName={`${MENU_ACTION} text-danger`} confirm={`Revoke this session for ${name}?`} /></RowMenu></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
        {tab === "documents" && (access.items.length === 0 ? <EmptyState title="No document records found" description="Try a different search." /> : (
          <Table caption="Documents">
            <thead><tr><Th>Name</Th><Th>Action</Th><Th>Document</Th><Th>Type</Th><Th>IP address</Th><Th>Date and time</Th></tr></thead>
            <tbody>
              {access.items.map(({ log, user, title, category }) => (
                <tr key={log.id}>
                  <Td className="font-medium">{user}</Td>
                  <Td>{log.action === "denied" ? <Badge tone="danger">Denied</Badge> : <Badge tone={log.action === "upload" ? "info" : "neutral"}>{areaName(log.action)}</Badge>}</Td>
                  <Td className="max-w-xs truncate">{title}</Td>
                  <Td>{DOCUMENT_CATEGORIES[category as keyof typeof DOCUMENT_CATEGORIES] ?? category}</Td>
                  <Td>{log.ipAddress ?? "-"}</Td>
                  <Td><DateText value={log.createdAt} withTime /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
        <Pagination data={tab === "events" ? events : tab === "sessions" ? sessions : access} base="/admin/audit" params={params} label="records" />
      </Card>
    </>
  );
}
