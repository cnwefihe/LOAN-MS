import Link from "next/link";
import type { FundPosition, fundPositions } from "@/server/services/funds";
import { Alert, Card, DateText, Money, Progress, Table, Td, Th } from "./ui";

type Positions = Awaited<ReturnType<typeof fundPositions>>;

/**
 * One school's fund pool for the year: what was set aside, what has been paid out and what is left.
 * Shown to the Bursary Officer reviewing an application from that school.
 */
export function FundPoolCard({ pos, manage, className = "mb-6" }: { pos: FundPosition; manage?: boolean; className?: string }) {
  const actions = manage ? <Link href="/finance#pool" className="link text-sm">{pos.set ? "Change" : "Set the pool"}</Link> : undefined;
  const title = `Fund pool ${pos.year}: ${pos.school}`;
  if (!pos.set) {
    return (
      <Card title={title} className={className} actions={actions}>
        <p className="text-sm text-warning-ink">Not set yet. Loans for {pos.school} cannot be cleared or paid out until the Head of Account or Payroll Manager sets its fund pool for {pos.year}.</p>
      </Card>
    );
  }
  const low = Number(pos.free) <= 0;
  return (
    <Card title={title} className={className} actions={actions}
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

/** Every school's fund pool for the year, with the totals. */
export function FundPoolsCard({ pools, manage, className = "mb-6" }: { pools: Positions; manage?: boolean; className?: string }) {
  const actions = manage ? <Link href="/finance#pool" className="link text-sm">Set a pool</Link> : undefined;
  const notSet = pools.schools.filter((p) => !p.set).length;
  return (
    <Card title={`Fund pools ${pools.year}`} className={className} actions={actions}
      description={pools.schools.length ? (notSet ? `One pool per school. ${notSet} of ${pools.schools.length} not set yet.` : "One pool per school.") : undefined}
      bodyClassName="p-5 pt-0">
      {pools.schools.length === 0 ? (
        <p className="pt-5 text-sm text-muted">No schools yet. An administrator adds them under Organisation.</p>
      ) : (
        <Table caption={`Fund pools ${pools.year}`}>
          <thead><tr><Th>School</Th><Th right>Pool</Th><Th right>Paid out</Th><Th right>Committed</Th><Th right>Free to lend</Th></tr></thead>
          <tbody>
            {pools.schools.map((p) => (
              <tr key={p.schoolId}>
                <Td className="font-medium">{p.school}</Td>
                {p.set ? <>
                  <Td right><Money value={p.amount} /></Td>
                  <Td right><Money value={p.paidOut} /></Td>
                  <Td right><Money value={p.committed} /></Td>
                  <Td right className={Number(p.free) <= 0 ? "font-semibold text-danger" : "font-semibold text-success"}><Money value={p.free} /></Td>
                </> : <Td colSpan={4} right className="text-warning-ink">Not set</Td>}
              </tr>
            ))}
            <tr className="border-t-2 border-line font-semibold">
              <Td>Total</Td>
              <Td right><Money value={pools.total.amount} /></Td>
              <Td right><Money value={pools.total.paidOut} /></Td>
              <Td right><Money value={pools.total.committed} /></Td>
              <Td right><Money value={pools.total.free} /></Td>
            </tr>
          </tbody>
        </Table>
      )}
      {pools.unassigned && <div className="mt-4"><Alert tone="warning">Some loans belong to a department with no school, so no pool covers them. An administrator can put each department in a school under Organisation.</Alert></div>}
    </Card>
  );
}
