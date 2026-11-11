import Link from "next/link";
import type { FundPosition } from "@/server/services/funds";
import { Card, DateText, Money, Progress } from "./ui";

/**
 * The year's fund pool for staff loans: what was set aside, what has been paid out and what is left.
 * Shown to the Bursary, Accounts Payable, Payroll Manager and Head of Account.
 */
export function FundPoolCard({ pos, manage, className = "mb-6" }: { pos: FundPosition; manage?: boolean; className?: string }) {
  const actions = manage ? <Link href="/finance#pool" className="link text-sm">{pos.set ? "Change" : "Set the pool"}</Link> : undefined;
  if (!pos.set) {
    return (
      <Card title={`Fund pool ${pos.year}`} className={className} actions={actions}>
        <p className="text-sm text-warning-ink">Not set yet. Loans cannot be cleared or paid out until the Head of Account sets the fund pool for {pos.year}.</p>
      </Card>
    );
  }
  const low = Number(pos.free) <= 0;
  return (
    <Card title={`Fund pool ${pos.year}`} className={className} actions={actions}
      description={<>Set at <Money value={pos.amount} />{pos.setBy ? <> by {pos.setBy}</> : null}{pos.updatedAt ? <> on <DateText value={pos.updatedAt} /></> : null}.</>}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
        <div><dt className="text-xs text-muted">Paid out</dt><dd className="font-semibold"><Money value={pos.paidOut} /></dd><dd className="text-xs text-muted">{pos.paidOutCount} {pos.paidOutCount === 1 ? "loan" : "loans"}</dd></div>
        <div><dt className="text-xs text-muted">Available</dt><dd className="font-semibold text-navy"><Money value={pos.available} /></dd><dd className="text-xs text-muted">Pool less paid out</dd></div>
        <div><dt className="text-xs text-muted">Committed</dt><dd className="font-semibold"><Money value={pos.committed} /></dd><dd className="text-xs text-muted">{pos.awaitingCount} awaiting payment, {pos.withApproversCount} with approvers</dd></div>
        <div><dt className="text-xs text-muted">Free to lend</dt><dd className={`font-semibold ${low ? "text-danger" : "text-success"}`}><Money value={pos.free} /></dd><dd className="text-xs text-muted">{low ? "No new loans can be cleared" : "Available less committed"}</dd></div>
      </dl>
      <div className="mt-4"><Progress value={pos.usedPercent} label={`${pos.usedPercent.toFixed(0)}% of the pool paid out`} /></div>
      {pos.note && <p className="mt-3 text-xs text-muted">{pos.note}</p>}
    </Card>
  );
}
