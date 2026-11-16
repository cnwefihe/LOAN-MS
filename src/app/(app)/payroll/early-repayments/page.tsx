import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { earlyRepaymentList } from "@/server/services/loans";
import { paginate, Pagination } from "@/components/pagination";
import { RowMenu } from "@/components/row-menu";
import { Card, DateText, EmptyState, Money, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Early repayments" };

export default async function EarlyRepayments({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const actor = await requireActor("payroll.view");
  const { page, size } = await searchParams;
  const rows = await earlyRepaymentList(await getDb(), actor);
  const pg = paginate(rows, page, size);
  return (
    <>
      <PageHeader title="Early repayments" crumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Early repayments" }]}
        description="Loans repaid in full by transfer. Check each payment, then close the loan." />
      <Card bodyClassName="p-5">
        {pg.items.length === 0 ? <EmptyState title="No early repayments yet" /> : (
          <Table caption="Early repayments">
            <thead><tr><Th>Loan</Th><Th>Name</Th><Th right>Amount paid</Th><Th right>Interest saved</Th><Th>Status</Th><Th>Sent</Th><Th className="sticky right-0"><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {pg.items.map(({ r, accountNumber, borrower }) => (
                <tr key={r.id}>
                  <Td className="font-medium"><Link className="link" href={`/payroll/early-repayments/${r.id}`}>{accountNumber}</Link></Td>
                  <Td>{borrower}</Td>
                  <Td right><Money value={r.amount} /></Td>
                  <Td right><Money value={r.interestSaved} /></Td>
                  <Td><StatusBadge status={r.status === "rejected" ? "declined" : r.status} /></Td>
                  <Td><DateText value={r.createdAt} withTime /></Td>
                  <Td right className="sticky right-0 bg-white"><RowMenu label={accountNumber} items={[{ label: r.status === "pending" ? "Review" : "View", href: `/payroll/early-repayments/${r.id}` }]} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/payroll/early-repayments" label="early repayments" />
      </Card>
    </>
  );
}
