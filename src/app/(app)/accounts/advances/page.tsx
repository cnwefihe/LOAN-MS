import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { advancesRegister } from "@/server/services/advances";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { dec, sum } from "@/lib/finance/money";
import { Badge, Card, DateText, EmptyState, Money, PageHeader, Stat, StatGrid, Table, Td, Th } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";

export const metadata = { title: "Advances" };

export default async function Advances({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const sp = await searchParams;
  const actor = await requireActor("accounts.view");
  const rows = await advancesRegister(await getDb(), actor);
  const open = rows.filter((r) => !r.recovered && r.status !== "cancelled");
  const byType = (t: string) => open.filter((r) => r.type === t);
  const total = (list: typeof rows) => sum(list.map((r) => dec(r.amount))).toFixed(2);

  const pg = paginate(rows, sp.page, sp.size);

  return (
    <>
      <PageHeader title="Advances" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Advances" }]}
        description="Deduct each advance when the payment it is against is made." />
      <StatGrid>
        <Stat label="Salary advances" value={<Money value={total(byType("salary"))} />} hint={`${byType("salary").length} to deduct`} tone="brand" />
        <Stat label="Leave allowance advances" value={<Money value={total(byType("leave_allowance"))} />} hint={`${byType("leave_allowance").length} to deduct`} />
        <Stat label="13th month advances" value={<Money value={total(byType("thirteenth_month"))} />} hint={`${byType("thirteenth_month").length} to deduct`} />
        <Stat label="Recovered" value={rows.filter((r) => r.recovered).length} hint="Deducted in full" />
      </StatGrid>
      <Card bodyClassName="p-5">
        {rows.length === 0 ? <EmptyState title="No advances yet" /> : (
          <Table caption="Advances register">
            <thead><tr><Th>Reference</Th><Th>Staff member</Th><Th>Against</Th><Th right>Advanced</Th><Th right>Payment after deductions</Th><Th right>Still payable to staff</Th><Th>Deduct on</Th><Th>Status</Th></tr></thead>
            <tbody>
              {pg.items.map((r) => (
                <tr key={r.loanId} className="hover:bg-slate-50">
                  <Td><Link className="link" href={`/accounts/loans/${r.loanId}`}>{r.accountNumber}</Link></Td>
                  <Td>{r.name}<p className="text-xs text-muted">{r.staffNumber ?? ""}</p></Td>
                  <Td>{ADVANCE_TYPES[r.type]}</Td>
                  <Td right><Money value={r.amount} /></Td>
                  <Td right><Money value={r.paymentNet} /></Td>
                  <Td right><Money value={r.stillPayable} /></Td>
                  <Td>{r.deductOn ? <DateText value={r.deductOn} /> : "When paid out"}</Td>
                  <Td><Badge tone={r.recovered ? "success" : r.stage === "To be paid out" ? "info" : "warning"}>{r.stage}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/accounts/advances" label="advances" />
      </Card>
    </>
  );
}
