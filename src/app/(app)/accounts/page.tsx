import Link from "next/link";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getWording } from "@/server/wording";
import { loanAccounts, repaymentClaims, financialTransactions, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { portfolioSummary } from "@/server/services/reports";
import { ApprovalOverview, OverviewHeading } from "@/components/approval-overview";
import { can } from "@/server/actor";
import { Card, PageHeader, Stat, StatGrid, Money, Table, Th, Td, StatusBadge, DateText } from "@/components/ui";

export const metadata = { title: "Bursary" };

export default async function AccountsDashboard() {
  const actor = await requireActor("accounts.view");
  const db = await getDb();
  const w = await getWording(db);
  const n = sql<number>`count(*)`;
  const [[awaiting], [live], [claims], [checker]] = await Promise.all([
    db.select({ n, amt: sql<string>`coalesce(sum(${loanAccounts.principal}),0)` }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement")),
    db.select({ n }).from(loanAccounts).where(inArray(loanAccounts.status, ["active", "overdue", "defaulted"])),
    db.select({ n, amt: sql<string>`coalesce(sum(${repaymentClaims.amount}),0)` }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId))),
    db.select({ n }).from(financialTransactions).where(eq(financialTransactions.status, "pending_approval")),
  ]);
  const summary = can(actor, "reports.view") ? await portfolioSummary(db, actor) : null;
  const recent = await db.select({ t: financialTransactions, acct: loanAccounts.accountNumber, borrower: users.displayName }).from(financialTransactions)
    .innerJoin(loanAccounts, eq(loanAccounts.id, financialTransactions.loanAccountId)).innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .where(sql`${financialTransactions.type} <> 'interest_recognition'`).orderBy(sql`${financialTransactions.createdAt} desc`).limit(10);

  const cards = (
    <>
      <StatGrid>
        <Stat label="Approved, awaiting payment" value={Number(awaiting.n)} hint={<Money value={awaiting.amt} />} tone="warning" href="/accounts/disbursements" />
        <Stat label="Loans being repaid" value={Number(live.n)} href="/accounts/loans" />
        <Stat label="Deduction claims to verify" value={Number(claims.n)} hint={<Money value={claims.amt} />} href="/accounts/repayments" />
        <Stat label="Pending authorisations" value={Number(checker.n)} tone={Number(checker.n) ? "warning" : "default"} href="/accounts/approvals" />
      </StatGrid>
      {summary && (
        <StatGrid>
          <Stat label="Outstanding exposure" value={<Money value={summary.loans.outstanding} />} tone="brand" />
          <Stat label="Total disbursed" value={<Money value={summary.loans.disbursed} />} />
          <Stat label="Total recovered" value={<Money value={summary.loans.recovered} />} tone="success" />
          <Stat label="Overdue / in default" value={`${summary.loans.overdueCount} / ${summary.loans.defaultedCount}`} hint={<><Money value={summary.loans.overdueAmount} /> / <Money value={summary.loans.defaultedAmount} /></>} tone={summary.loans.defaultedCount ? "danger" : summary.loans.overdueCount ? "warning" : "default"} href="/accounts/loans?status=overdue" />
        </StatGrid>
      )}
    </>
  );

  return (
    <>
      <PageHeader title="Overview" description="Funds reviews, disbursements, repayments and reconciliation." />
      {can(actor, "approval.decide") ? <><OverviewHeading>Bursary</OverviewHeading>{cards}<ApprovalOverview db={db} actor={actor} /></> : cards}
      <Card title="Recent transactions" actions={<Link href="/accounts/loans" className="link text-sm">Loan book</Link>} bodyClassName="p-5 pt-0">
        <Table caption="Recent transactions">
          <thead><tr><Th>Reference</Th><Th>Loan</Th><Th>Type</Th><Th right>Amount</Th><Th>Value date</Th><Th>Status</Th></tr></thead>
          <tbody>
            {recent.map(({ t, acct, borrower }) => (
              <tr key={t.id}><Td className="font-mono text-xs">{t.reference}</Td><Td><Link className="link" href={`/accounts/loans/${t.loanAccountId}`}>{acct}</Link><p className="text-xs text-muted">{borrower}</p></Td><Td className="capitalize">{t.type.replace(/_/g, " ")}</Td><Td right><Money value={t.amount} /></Td><Td><DateText value={t.valueDate} /></Td><Td><StatusBadge status={t.status} txn /></Td></tr>
            ))}
            {!recent.length && <tr><Td colSpan={6} className="text-muted">No transactions yet.</Td></tr>}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
