import { dec, m } from "@/lib/finance/money";
import { instalmentLabel } from "@/lib/finance/calculator";
import { Money, StatusBadge, DateText, Table, Th, Td, KeyValues, Progress, Badge } from "./ui";
import { paginate, Pagination } from "./pagination";
import type { getLoanDetail } from "@/server/services/loans";

type Detail = Awaited<ReturnType<typeof getLoanDetail>>;

/** `showPolicy` adds the policy version the loan was approved on, for staff; borrowers do not see version numbers. */
export function LoanSummary({ d, showPolicy }: { d: Detail; showPolicy?: boolean }) {
  const { loan } = d;
  const outstanding = dec(loan.principalOutstanding).plus(loan.interestOutstanding);
  const pct = dec(loan.totalRepayable).isZero() ? 0 : dec(loan.totalRepaid).div(loan.totalRepayable).times(100).toNumber();
  return (
    <>
      <KeyValues columns={3} items={[
        ["Principal", <Money key="p" value={loan.principal} />],
        ["Total repayable", <Money key="tr" value={loan.totalRepayable} />],
        [instalmentLabel(loan.repaymentPeriodMonths), <Money key="mi" value={loan.monthlyInstalment} />],
        ["Outstanding (confirmed)", <Money key="o" value={outstanding.toFixed(2)} className="text-base font-semibold" />],
        ["Principal / interest outstanding", <><Money value={loan.principalOutstanding} /> / <Money value={loan.interestOutstanding} /></>],
        ["Total repaid", <Money key="r" value={loan.totalRepaid} />],
        ["Interest", `${loan.interestMethod.replace("_", " ")} · ${Number(loan.annualInterestRate)}% p.a.`],
        ["Disbursed", <DateText key="d" value={loan.disbursedAt} />],
        ["Expected completion", <DateText key="c" value={loan.maturityDate} />],
        ["Days past due", loan.daysPastDue ? <Badge tone="warning">{loan.daysPastDue} days</Badge> : "0"],
        ["Overpayment credit", <Money key="ov" value={loan.overpaymentBalance} />],
        ...(showPolicy ? [["Policy", `${d.product.code} v${d.policy.version}`] as [string, React.ReactNode]] : []),
      ]} />
      {loan.disbursedAt && <div className="mt-5"><Progress value={pct} label="Repayment progress (confirmed payments)" /></div>}
    </>
  );
}

export function ScheduleTable({ d }: { d: Detail }) {
  if (!d.schedule) return <p className="text-sm text-muted">The repayment schedule is created when the loan is disbursed.</p>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <p className="mb-3 text-xs text-muted">Schedule version {d.schedule.schedule.version} ({d.schedule.schedule.reason}){d.schedules.length > 1 ? ` · ${d.schedules.length - 1} earlier version(s) superseded` : ""}</p>
      <Table caption="Repayment schedule">
        <thead><tr><Th>#</Th><Th>Due date</Th><Th right>Principal</Th><Th right>Interest</Th><Th right>Expected</Th><Th right>Confirmed paid</Th><Th right>Outstanding</Th><Th>Status</Th></tr></thead>
        <tbody>
          {d.schedule.instalments.map((i) => {
            const paid = dec(i.principalPaid).plus(i.interestPaid);
            const remaining = dec(i.totalDue).minus(paid);
            return (
              <tr key={i.id} className={i.dueDate <= today && i.status !== "paid" ? "bg-warning-50/40" : undefined}>
                <Td>{i.sequence}</Td>
                <Td><DateText value={i.dueDate} /></Td>
                <Td right><Money value={i.principalDue} /></Td>
                <Td right><Money value={i.interestDue} /></Td>
                <Td right><Money value={i.totalDue} /></Td>
                <Td right><Money value={m(paid)} /></Td>
                <Td right><Money value={m(remaining)} /></Td>
                <Td><StatusBadge status={i.status} /></Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}

export function TransactionsTable({ d, showInternal, base, page, size }: { d: Detail; showInternal: boolean; base: string; page?: string; size?: string }) {
  const rows = d.txns.filter((t) => showInternal || (t.t.type !== "interest_recognition" && t.t.status !== "rejected"));
  if (!rows.length) return <p className="text-sm text-muted">No transactions yet.</p>;
  const pg = paginate(rows, page, size);
  return (
    <>
    <Table caption="Financial transactions">
      <thead><tr><Th>Value date</Th><Th>Reference</Th><Th>Type</Th><Th right>Amount</Th><Th>Status</Th><Th>Narration</Th>{showInternal && <Th>Maker</Th>}<Th>Receipt</Th></tr></thead>
      <tbody>
        {pg.items.map(({ t, makerName }) => (
          <tr key={t.id}>
            <Td><DateText value={t.valueDate} /></Td>
            <Td className="font-mono text-xs">{t.reference}{t.externalReference && <p className="text-muted">{t.externalReference}</p>}</Td>
            <Td className="capitalize">{t.type.replace(/_/g, " ")}</Td>
            <Td right><Money value={t.amount} /></Td>
            <Td><StatusBadge status={t.status} txn /></Td>
            <Td className="min-w-56 max-w-xs text-xs !whitespace-normal">{t.narration}{t.rejectionReason && <p className="text-danger">Rejected: {t.rejectionReason}</p>}</Td>
            {showInternal && <Td className="text-xs">{makerName}</Td>}
            <Td>{t.status === "posted" && (t.type === "repayment" || t.type === "early_settlement") ? <a className="link text-xs" href={`/api/transactions/${t.id}/receipt`}>PDF<span className="sr-only"> receipt {t.reference}</span></a> : null}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
    <Pagination data={pg} base={base} params={{ tab: "payments" }} label="transactions" />
    </>
  );
}

export function ClaimsTable({ d }: { d: Detail }) {
  if (!d.claims.length) return <p className="text-sm text-muted">No deductions reported.</p>;
  return (
    <Table caption="Reported deductions">
      <thead><tr><Th>Month</Th><Th right>Amount</Th><Th>Channel</Th><Th>Status</Th><Th>Review</Th></tr></thead>
      <tbody>
        {d.claims.map((c) => (
          <tr key={c.id}>
            <Td>{c.deductionMonth.slice(0, 7)}</Td>
            <Td right><Money value={c.amount} /></Td>
            <Td className="capitalize">{c.channel.replace("_", " ")}</Td>
            <Td><StatusBadge status={c.status === "pending" && c.transactionId ? "pending_confirmation" : c.status} /></Td>
            <Td className="text-xs">{c.reviewComment ?? "N/A"}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
