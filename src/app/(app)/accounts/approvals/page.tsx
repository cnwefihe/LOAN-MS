import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { financialTransactions, loanAccounts, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import type { Line } from "@/server/services/ledger";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, Money, DateText, EmptyState, Table, Th, Td } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { approveTxnAction, rejectTxnAction } from "@/app/actions/accounts";

export const metadata = { title: "Pending authorisations" };

export default async function CheckerQueue({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const sp = await searchParams;
  const actor = await requireActor("accounts.view", "transaction.approve");
  const db = await getDb();
  const rows = await db.select({ t: financialTransactions, acct: loanAccounts.accountNumber, borrowerId: loanAccounts.borrowerId, maker: users.displayName }).from(financialTransactions)
    .innerJoin(loanAccounts, eq(loanAccounts.id, financialTransactions.loanAccountId)).innerJoin(users, eq(users.id, financialTransactions.makerId))
    .where(eq(financialTransactions.status, "pending_approval")).orderBy(financialTransactions.createdAt);
  const checker = can(actor, "transaction.approve");
  const pg = paginate(rows, sp.page, sp.size);
  return (
    <>
      <PageHeader title="Pending authorisations" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Pending authorisations" }]}
        description="Transactions awaiting a second officer's approval." />
      {rows.length === 0 ? <Card><EmptyState title="No transactions awaiting approval" /></Card> : (
        <div className="space-y-4">
          {pg.items.map(({ t, acct, borrowerId, maker }) => (
            <Card key={t.id} title={<span className="capitalize">{t.type.replace(/_/g, " ")}: <Money value={t.amount} /></span>} description={<>{t.reference} · <Link className="link" href={`/accounts/loans/${t.loanAccountId}`}>{acct}</Link> · proposed by {maker} · <DateText value={t.createdAt} withTime /></>}>
              <p className="text-sm">{t.narration}</p>
              {t.externalReference && <p className="text-xs text-muted">External reference: {t.externalReference}</p>}
              <Table caption="Proposed ledger lines" className="mt-3">
                <thead><tr><Th>Account</Th><Th right>Debit</Th><Th right>Credit</Th></tr></thead>
                <tbody>{((t.proposedEntries as Line[]) ?? []).map((l, i) => <tr key={i}><Td className="font-mono text-xs">{l.account}</Td><Td right>{l.direction === "debit" ? <Money value={l.amount} /> : ""}</Td><Td right>{l.direction === "credit" ? <Money value={l.amount} /> : ""}</Td></tr>)}</tbody>
              </Table>
              {(t.type === "repayment" || t.type === "early_settlement") && <p className="mt-2 text-xs text-muted">Receipt allocation is recalculated against the latest balances when approved.</p>}
              {checker && t.makerId !== actor.userId && borrowerId !== actor.userId ? (
                <div className="mt-4 flex flex-wrap items-start gap-4">
                  <ActionForm action={approveTxnAction.bind(null, t.id)} submitLabel="Approve and post" variant="success" confirm={`Approve and post ${t.reference}?`} />
                  <ActionForm action={rejectTxnAction.bind(null, t.id)} submitLabel="Reject" variant="secondary">
                    <label htmlFor={`rj-${t.id}`} className="sr-only">Reason</label><input id={`rj-${t.id}`} name="reason" required placeholder="Reason" className="input" />
                  </ActionForm>
                </div>
              ) : <p className="mt-3 text-xs text-warning-ink">{t.makerId === actor.userId ? "You proposed this transaction; another checker must approve it." : "Requires a user with checker rights."}</p>}
            </Card>
          ))}
          <Pagination data={pg} base="/accounts/approvals" label="transactions" />
        </div>
      )}
    </>
  );
}
