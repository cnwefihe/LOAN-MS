import { requireActor } from "@/lib/auth/session";
import { connectionStatus } from "@/server/integrations/status";
import { Badge, Card, PageHeader, Table, Th, Td } from "@/components/ui";

export const metadata = { title: "Connections" };

export default async function Connections() {
  await requireActor("admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.settings.manage", "admin.audit.view");
  return (
    <>
      <PageHeader title="Connections" crumbs={[{ label: "Control centre", href: "/admin" }, { label: "Connections" }]} description="Shows only what is actually configured." />
      <Card bodyClassName="p-5 py-0">
        <Table caption="Connections">
          <thead><tr><Th>Connection</Th><Th>Status</Th><Th>What it needs</Th></tr></thead>
          <tbody>
            {connectionStatus().map((c) => (
              <tr key={c.name}>
                <Td className="font-medium">{c.name}</Td>
                <Td>{c.ok ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured</Badge>}</Td>
                <Td className="min-w-72 text-xs text-muted whitespace-normal!">{c.needs}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
