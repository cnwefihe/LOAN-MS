import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { SETTINGS, type SettingKey } from "@/server/settings";
import { activityName, areaName, deviceName, networkName } from "@/lib/activity";
import { Card, DateText, KeyValues, PageHeader, Table, Th, Td } from "@/components/ui";

export const metadata = { title: "Activity details" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shown = (v: unknown) => (v === undefined || v === null || v === "" ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));
const fieldName = (k: string) => { const s = k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : v === undefined || v === null ? {} : { value: v });

export default async function ActivityDetails({ params }: { params: Promise<{ id: string }> }) {
  await requireActor("admin.audit.view");
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) notFound();
  const db = await getDb();
  const [row] = await db.select({ log: auditLogs, who: users.displayName, email: users.email }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(eq(auditLogs.id, Number(id)));
  if (!row) notFound();
  const { log, who, email } = row;
  const before = asRecord(log.before), after = asRecord(log.after);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const title = activityName(log.action);

  // Name what the action was done to, instead of showing an internal id.
  const rawId = log.entityId ?? "";
  const [person] = log.entityType === "user" && UUID.test(rawId) ? await db.select({ name: users.displayName }).from(users).where(inArray(users.id, [rawId])) : [];
  const target = person?.name ?? SETTINGS[rawId as SettingKey]?.label ?? (rawId && !UUID.test(rawId) ? rawId : null);
  const description = log.action === "session.revoked" && person ? `Signed ${person.name} out of one session.` : log.summary;

  return (
    <>
      <PageHeader title={title} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Activity", href: "/admin/audit" }, { label: title }]} description={description ?? undefined} />
      <div className="space-y-6">
        <Card title="Details">
          <KeyValues columns={6} items={[
            ["Name", who ?? "System"],
            ["Email", email ?? "-"],
            ["Module", areaName(log.entityType)],
            ["Applies to", target ?? "-"],
            ["Date and time", <DateText key="when" value={log.createdAt} withTime />],
            ["Device", <span key="device">{deviceName(log.userAgent)}<span className="block text-xs font-normal text-muted">{networkName(log.ipAddress)}</span></span>],
          ]} />
          {rawId && <p className="mt-4 break-all border-t border-line pt-3 text-xs text-muted">Record ID: <span className="font-mono">{rawId}</span></p>}
        </Card>
        {fields.length > 0 && (
          <Card title="What changed" bodyClassName="p-5 py-0">
            <Table caption="What changed">
              <thead><tr><Th>Field</Th><Th>Before</Th><Th>After</Th></tr></thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f}>
                    <Td className="font-medium">{fieldName(f)}</Td>
                    <Td className="min-w-48 text-muted whitespace-normal! break-all">{shown(before[f])}</Td>
                    <Td className="min-w-48 whitespace-normal! break-all">{shown(after[f])}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}
