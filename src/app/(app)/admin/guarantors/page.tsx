import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { GUARANTEE_FILTERS, guaranteeRequests, type GuaranteeFilter } from "@/server/services/guarantor-pool";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { Badge, Card, DateText, EmptyState, Money, PageHeader, Stat, StatGrid, Table, Tabs, Td, Th } from "@/components/ui";

export const metadata = { title: "Guarantors" };

const REPLY: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  pending: { label: "Awaiting reply", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  clarification_requested: { label: "Asked a question", tone: "info" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
  replaced: { label: "Replaced", tone: "neutral" },
};

const TAB_LABEL: Record<GuaranteeFilter, string> = { all: "All", active: "Active", pending: "Awaiting reply", accepted: "Accepted", declined: "Declined" };

export default async function Guarantors({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("admin.policy.manage");
  const sp = await searchParams;
  const tab: GuaranteeFilter = (GUARANTEE_FILTERS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as GuaranteeFilter) : "all";
  const all = await guaranteeRequests(await getDb(), actor);
  const pick = (t: GuaranteeFilter) => t === "all" ? all : t === "active" ? all.filter((r) => r.active) : all.filter((r) => r.status === t);
  const q = sp.q?.trim().toLowerCase();
  const list = pick(tab).filter((r) => !q || `${r.guarantor} ${r.email} ${r.applicant} ${r.reference}`.toLowerCase().includes(q));
  const pg = paginate(list, sp.page, sp.size);
  const people = new Set(all.map((r) => r.guarantorId)).size;

  return (
    <>
      <PageHeader title="Guarantors" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Guarantors" }]}
        description="Staff chosen as guarantors and their responses. Any staff member who meets the loan policy may be chosen." />
      <StatGrid>
        <Stat label="People chosen" value={people} />
        <Stat label="Guaranteeing a loan now" value={new Set(pick("active").map((r) => r.guarantorId)).size} tone="brand" />
        <Stat label="Awaiting reply" value={pick("pending").length} tone={pick("pending").length ? "warning" : "default"} />
        <Stat label="Declined" value={pick("declined").length} />
      </StatGrid>
      <Tabs base="/admin/guarantors" active={tab} tabs={GUARANTEE_FILTERS.map((t) => ({ key: t, label: TAB_LABEL[t], count: pick(t).length }))} />
      <Card bodyClassName="p-5" className="min-w-0">
        <SearchFilter q={sp.q} placeholder="Search guarantor, applicant or reference" hidden={{ tab }} />
        {pg.items.length === 0 ? <EmptyState title={all.length ? "Nothing found" : "No one has been chosen as a guarantor yet"} description={all.length ? "Try a different search or tab." : "People appear here once an applicant chooses them."} /> : (
          <Table caption="Guarantee requests">
            <thead><tr><Th>Guarantor</Th><Th>Applicant</Th><Th right>Amount guaranteed</Th><Th>Response</Th><Th>Guarantee status</Th><Th>Requested</Th><Th>Responded</Th></tr></thead>
            <tbody>
              {pg.items.map((r) => {
                const reply = REPLY[r.status] ?? { label: r.status, tone: "neutral" as const };
                return (
                  <tr key={r.id}>
                    <Td className="font-medium">{r.guarantor}<p className="text-xs font-normal text-muted">{r.email}</p></Td>
                    <Td>{r.applicant}<p className="font-mono text-xs text-muted">{r.reference}</p></Td>
                    <Td right><Money value={r.amount} /></Td>
                    <Td><Badge tone={reply.tone}>{reply.label}</Badge></Td>
                    <Td>{r.active ? <Badge tone="success">Active</Badge> : <Badge>Not active</Badge>}</Td>
                    <Td><DateText value={r.invitedAt} /></Td>
                    <Td>{r.respondedAt ? <DateText value={r.respondedAt} /> : <span className="text-muted">Not yet</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/admin/guarantors" params={{ tab, q: sp.q }} label="guarantors" />
      </Card>
    </>
  );
}
