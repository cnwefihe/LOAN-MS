import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { payrollOverview } from "@/server/services/payroll";
import { fundPosition } from "@/server/services/funds";
import { FundPoolCard } from "@/components/fund-pool";
import { Card, DateText, EmptyState, Money, PageHeader, Stat, StatGrid, StatusBadge, Table, Td, Th, Badge } from "@/components/ui";

export const metadata = { title: "Payroll" };

/** Deductions and repayments for the Payroll Manager and Payroll Officer. */
export default async function PayrollOverview() {
  const actor = await requireActor("payroll.view");
  const db = await getDb();
  const o = await payrollOverview(db, actor);
  const pool = can(actor, "fund.view") ? await fundPosition(db) : null;
  const monthLabel = new Date(`${o.month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const loanHref = (id: string) => (can(actor, "accounts.view") ? `/accounts/loans/${id}` : undefined);

  return (
    <>
      <PageHeader title="Payroll" description="Salary deductions, repayments and early repayments." />
      <StatGrid>
        <Stat label={`Deductions due in ${monthLabel}`} value={<Money value={o.dueTotal} />} hint={`${o.due.length} instalments`} tone="brand" />
        <Stat label={`Received in ${monthLabel}`} value={<Money value={o.received.total} />} hint={`${o.received.count} repayments recorded`} tone="success" />
        <Stat label="First deductions to confirm" value={o.claimsToConfirm} hint={`${o.awaitingFirst.length} loans not yet automatic`} tone={o.claimsToConfirm ? "warning" : "default"} href={can(actor, "repayment.confirm") ? "/accounts/repayments" : undefined} />
        <Stat label="Early repayments to confirm" value={o.earlyPending.count} hint={<Money value={o.earlyPending.total} />} tone={o.earlyPending.count ? "warning" : "default"} href="/payroll/early-repayments" />
      </StatGrid>
      {pool && <FundPoolCard pos={pool} />}

      <Card title={`Deductions for ${monthLabel}`} className="mb-6" description="Loans on automatic deduction are recorded on their due dates. The others wait for the borrower to report the first deduction and the Payroll Officer to confirm it." bodyClassName="p-5 pt-0">
        {o.due.length === 0 ? <EmptyState title="Nothing due this month" /> : (
          <Table caption={`Deductions for ${monthLabel}`}>
            <thead><tr><Th>Loan</Th><Th>Name</Th><Th>Due</Th><Th right>Instalment</Th><Th right>Still to receive</Th><Th>Deduction</Th><Th>Status</Th></tr></thead>
            <tbody>
              {o.due.map((d) => (
                <tr key={d.i.id}>
                  <Td>{loanHref(d.loanId) ? <Link className="link" href={loanHref(d.loanId)!}>{d.accountNumber}</Link> : d.accountNumber}</Td>
                  <Td>{d.borrower}</Td>
                  <Td><DateText value={d.i.dueDate} /></Td>
                  <Td right><Money value={d.i.totalDue} /></Td>
                  <Td right><Money value={d.remaining} /></Td>
                  <Td>{d.automatic ? <Badge tone="success">Automatic</Badge> : <Badge tone="warning">First to confirm</Badge>}</Td>
                  <Td><StatusBadge status={d.i.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={`Loans waiting for their first deduction to be confirmed (${o.awaitingFirst.length})`} description="Once the Payroll Officer confirms a loan's first salary deduction, the rest are recorded automatically." bodyClassName="p-5 pt-0">
        {o.awaitingFirst.length === 0 ? <EmptyState title="Every loan deducts automatically" /> : (
          <Table caption="Loans waiting for their first deduction">
            <thead><tr><Th>Loan</Th><Th>Name</Th><Th>Staff no.</Th><Th right>Instalment</Th><Th>First due</Th><Th>Status</Th></tr></thead>
            <tbody>
              {o.awaitingFirst.map(({ loan, borrower, staffNumber }) => (
                <tr key={loan.id}>
                  <Td>{loanHref(loan.id) ? <Link className="link" href={loanHref(loan.id)!}>{loan.accountNumber}</Link> : loan.accountNumber}</Td>
                  <Td>{borrower}</Td><Td>{staffNumber ?? "-"}</Td><Td right><Money value={loan.monthlyInstalment} /></Td><Td><DateText value={loan.firstDueDate} /></Td><Td><StatusBadge status={loan.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
