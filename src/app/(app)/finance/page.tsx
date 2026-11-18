import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { financeOverview } from "@/server/services/finance";
import { currentYear, fundPositions, poolHistory } from "@/server/services/funds";
import { schools } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { setFundPoolAction } from "@/app/actions/payroll";
import { ActionForm } from "@/components/action-form";
import { FundPoolsCard } from "@/components/fund-pool";
import { Card, DateText, Money, PageHeader, Stat, StatGrid, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Finance overview" };

/**
 * The Head of Account's overview: the fund pool, lending and repayments, and who is holding what. Opens for
 * anyone who may see the overview or set the fund pool; each part shows only to those allowed to see it.
 */
export default async function Finance() {
  const actor = await requireActor("finance.overview", "fund.manage");
  const db = await getDb();
  const overview = can(actor, "finance.overview");
  const f = overview ? await financeOverview(db, actor) : null;
  const year = f?.year ?? currentYear();
  const pools = f?.pools ?? await fundPositions(db, year);
  const history = f?.history ?? await poolHistory(db);
  const schoolList = await db.select({ id: schools.id, name: schools.name }).from(schools).where(eq(schools.isActive, true)).orderBy(asc(schools.name));
  return (
    <>
      <PageHeader title={overview ? "Finance overview" : "Fund pools"} description={overview ? "Each school's fund pool, lending and repayments, and the work waiting at each stage." : "The money set aside for staff loans each year, one pool per school."} />
      <FundPoolsCard pools={pools} />
      {f && <>
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
      </>}

      {can(actor, "fund.manage") && (
        <div id="pool" className="grid gap-6 lg:grid-cols-2">
          <Card title="Set a school's fund pool" description="For each school, for the year. Payouts reduce it; repayments do not add back. Setting it again replaces the amount.">
            {schoolList.length === 0 ? <p className="text-sm text-muted">No schools yet. An administrator adds them under Organisation.</p> : (
              <ActionForm action={setFundPoolAction} submitLabel="Save" confirm="Save this fund pool?">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2"><label htmlFor="schoolId" className="label">School</label>
                    <select id="schoolId" name="schoolId" required defaultValue="" className="input">
                      <option value="" disabled>Choose a school</option>
                      {schoolList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </div>
                  <div><label htmlFor="year" className="label">Year</label><input id="year" name="year" type="number" min={2000} max={2100} required defaultValue={year} className="input" /></div>
                  <div><label htmlFor="amount" className="label">Amount (₦)</label><input id="amount" name="amount" inputMode="decimal" required className="input" /></div>
                  <div className="sm:col-span-2"><label htmlFor="note" className="label">Note (optional)</label><input id="note" name="note" maxLength={300} className="input" /></div>
                </div>
              </ActionForm>
            )}
          </Card>
          <Card title="Pools set" bodyClassName="p-5 pt-0">
            <Table caption="Pools set">
              <thead><tr><Th>Year</Th><Th>School</Th><Th right>Pool</Th><Th>Last changed</Th></tr></thead>
              <tbody>
                {history.map((p) => <tr key={p.id}><Td>{p.year}</Td><Td>{p.school}</Td><Td right><Money value={p.amount} /></Td><Td><DateText value={p.updatedAt} />{p.setBy && <span className="block text-xs text-muted">{p.setBy}</span>}</Td></tr>)}
                {!history.length && <tr><Td colSpan={4} className="text-muted">No pool set yet.</Td></tr>}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
