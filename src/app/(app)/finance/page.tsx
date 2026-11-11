import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { financeOverview } from "@/server/services/finance";
import { setFundPoolAction } from "@/app/actions/payroll";
import { ActionForm } from "@/components/action-form";
import { FundPoolCard } from "@/components/fund-pool";
import { Card, DateText, Money, PageHeader, Stat, StatGrid, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Finance overview" };

/** The Head of Account's overview: the fund pool, lending and repayments, and who is holding what. */
export default async function Finance() {
  const actor = await requireActor("finance.overview");
  const db = await getDb();
  const f = await financeOverview(db, actor);
  return (
    <>
      <PageHeader title="Finance overview" description="The fund pool, lending and repayments, and the work waiting at each stage." />
      <FundPoolCard pos={f.pool} />
      <StatGrid>
        <Stat label="Loans being repaid" value={f.book.live} hint={<><Money value={f.book.outstanding} /> outstanding</>} tone="brand" />
        <Stat label={`Repaid in ${f.year}`} value={<Money value={f.repaid.total} />} hint={`${f.repaid.count} repayments · ${f.book.closedThisYear} loans closed`} tone="success" />
        <Stat label="Automatic deductions" value={`${f.book.automatic} of ${f.book.live}`} hint="Loans deducting automatically" />
        <Stat label="Overdue / in default" value={`${f.book.overdue} / ${f.book.defaulted}`} tone={f.book.defaulted ? "danger" : f.book.overdue ? "warning" : "default"} />
      </StatGrid>

      <Card title="Work waiting" className="mb-6" description="Contact the people responsible if something has waited too long." bodyClassName="p-5 pt-0">
        <Table caption="Work waiting">
          <thead><tr><Th>Stage</Th><Th right>Waiting</Th><Th right>Amount</Th><Th>Waiting since</Th><Th>Responsible</Th></tr></thead>
          <tbody>
            {f.stages.map((s) => (
              <tr key={s.stage}>
                <Td className="font-medium">{s.stage}</Td>
                <Td right>{s.count}</Td>
                <Td right>{s.count ? <Money value={s.amount} /> : "-"}</Td>
                <Td>{s.count && s.oldest ? <DateText value={s.oldest} /> : "-"}</Td>
                <Td>
                  <p className="text-xs text-muted">{s.roles}</p>
                  {s.people.length ? s.people.map((p) => <a key={p.email} className="link block text-sm" href={`mailto:${p.email}`}>{p.name}</a>) : <span className="text-sm text-muted">No one holds this role</span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {can(actor, "fund.manage") && (
        <div id="pool" className="grid gap-6 lg:grid-cols-2">
          <Card title="Set the fund pool" description="The money set aside for staff loans in the year. Loans paid out that year reduce it; repayments do not add back to it.">
            <ActionForm action={setFundPoolAction} submitLabel="Save">
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label htmlFor="year" className="label">Year</label><input id="year" name="year" type="number" min={2000} max={2100} required defaultValue={f.year} className="input" /></div>
                <div><label htmlFor="amount" className="label">Amount (₦)</label><input id="amount" name="amount" inputMode="decimal" required defaultValue={f.pool.set ? f.pool.amount : ""} className="input" /></div>
                <div className="sm:col-span-2"><label htmlFor="note" className="label">Note (optional)</label><input id="note" name="note" maxLength={300} defaultValue={f.pool.note ?? ""} className="input" /></div>
              </div>
            </ActionForm>
          </Card>
          <Card title="Pools by year" bodyClassName="p-5 pt-0">
            <Table caption="Pools by year">
              <thead><tr><Th>Year</Th><Th right>Pool</Th><Th>Last changed</Th></tr></thead>
              <tbody>
                {f.pools.map((p) => <tr key={p.id}><Td>{p.year}</Td><Td right><Money value={p.amount} /></Td><Td><DateText value={p.updatedAt} /></Td></tr>)}
                {!f.pools.length && <tr><Td colSpan={3} className="text-muted">No pool set yet.</Td></tr>}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
