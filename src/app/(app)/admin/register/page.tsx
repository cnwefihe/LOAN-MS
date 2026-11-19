import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { Lock } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { canOpen } from "@/lib/route-access";
import { monthsBetween, monthsText, todayLagos } from "@/lib/finance/dates";
import { listStaffRecords } from "@/server/services/staff-records";
import { devFixtureCode } from "@/server/services/mfa";
import { recordsOpen, registerIdleMinutes } from "@/server/records-unlock";
import { closeStaffRecordsAction, deleteStaffRecordAction, importStaffRecordsAction, openStaffRecordsAction, saveStaffRecordAction } from "@/app/actions/staff-records";
import { ActionForm } from "@/components/action-form";
import { RowMenu } from "@/components/row-menu";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { Badge, Card, DateText, EmptyState, PageHeader, Stat, StatGrid, Table, Tabs, Td, Th } from "@/components/ui";

export const metadata = { title: "Register" };

const TEMPLATE = `data:text/csv;charset=utf-8,${encodeURIComponent("Employee code,Pay grade,Employment date,Confirmation,Email\r\nEX/2020/001,Officer I Step 1,15/03/2020,Confirmed,first.last@example.edu.ng\r\n")}`;
const CRUMBS = [{ label: "Administration", href: "/admin" }, { label: "Settings", href: "/admin/settings" }, { label: "Register" }];

type Search = { q?: string; tab?: string; edit?: string; page?: string; size?: string };

export default async function StaffRecords({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireActor("register.view");
  const db = await getDb();
  const manage = can(actor, "register.manage");
  const crumbs = canOpen(actor.permissions, "/admin/settings") ? CRUMBS : [{ label: "Register" }];

  if (!(await recordsOpen(db, actor.userId))) {
    const dev = await devFixtureCode(db, actor.userId);
    return (
      <>
        <PageHeader title="Register" crumbs={crumbs} description="Employee code, pay grade, employment date and confirmation for every employee." />
        <Card title={<span className="flex items-center gap-2"><Lock aria-hidden className="h-4 w-4 text-brand" />Enter your code to open</span>} className="max-w-md"
          description={`For your security, enter the six-digit code from your authenticator app. The Register stays open while you use it and closes after ${await registerIdleMinutes(db)} minutes without activity.`}>
          <ActionForm action={openStaffRecordsAction} submitLabel="Open the Register">
            <label htmlFor="code" className="label">Authentication code</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className="input w-40 font-mono tracking-widest" />
            {dev && <p className="hint">Test account (development only). Current code: <strong data-testid="dev-mfa-code" className="font-mono">{dev}</strong></p>}
          </ActionForm>
        </Card>
      </>
    );
  }

  const sp = await searchParams;
  const all = await listStaffRecords(db, actor);
  const today = todayLagos();
  const tab = sp.tab === "linked" || sp.tab === "waiting" || sp.tab === "unconfirmed" ? sp.tab : "all";
  const pick = (t: string) => t === "linked" ? all.filter((r) => r.person) : t === "waiting" ? all.filter((r) => !r.person) : t === "unconfirmed" ? all.filter((r) => !r.confirmed) : all;
  const q = sp.q?.trim().toLowerCase();
  const list = pick(tab).filter((r) => !q || `${r.employeeCode} ${r.email ?? ""} ${r.payGrade} ${r.person?.name ?? ""}`.toLowerCase().includes(q));
  const pg = paginate(list, sp.page, sp.size);
  const editing = !manage ? undefined : sp.edit === "new" ? "new" : sp.edit ? all.find((r) => r.id === sp.edit) : undefined;

  return (
    <>
      <PageHeader title="Register" crumbs={crumbs}
        description="Each employee's code, pay grade, employment date and confirmation fill their profile when they sign in. They cannot change them."
        actions={<>
          {manage && <RowMenu label="Add to the Register" items={[{ label: "Add one employee", href: "/admin/register?edit=new" }]} />}
          <ActionForm action={closeStaffRecordsAction} submitLabel="Close" variant="secondary" submitClassName="btn-secondary h-8 px-3 text-xs" inline />
        </>} />
      <StatGrid>
        <Stat label="In the Register" value={all.length} />
        <Stat label="Signed in and filled" value={pick("linked").length} tone="success" />
        <Stat label="Not signed in yet" value={pick("waiting").length} />
        <Stat label="Not confirmed" value={pick("unconfirmed").length} tone={pick("unconfirmed").length ? "warning" : "default"} />
      </StatGrid>

      {editing && (
        <Card title={editing === "new" ? "Add an employee" : `Manage ${editing.employeeCode}`} className="mb-6 max-w-3xl" actions={<Link href="/admin/register" className="link text-xs">Close</Link>}>
          <ActionForm key={editing === "new" ? "new" : editing.id} action={saveStaffRecordAction.bind(null, editing === "new" ? null : editing.id)} submitLabel={editing === "new" ? "Add" : "Save changes"} listChanges
            confirm={editing === "new" ? "Add this employee to the Register?" : "Save these changes? The person's profile is updated at once."}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="employeeCode" className="label">Employee code</label><input id="employeeCode" name="employeeCode" required maxLength={40} defaultValue={editing === "new" ? "" : editing.employeeCode} className="input" /></div>
              <div><label htmlFor="payGrade" className="label">Pay grade</label><input id="payGrade" name="payGrade" required maxLength={120} defaultValue={editing === "new" ? "" : editing.payGrade} className="input" /><p className="hint">Exactly as printed on the payslip.</p></div>
              <div><label htmlFor="employmentDate" className="label">Employment date</label><DateInput id="employmentDate" name="employmentDate" required max={today} defaultValue={editing === "new" ? "" : editing.employmentDate} /></div>
              <div><label htmlFor="email" className="label">Work email (optional)</label><input id="email" name="email" type="email" maxLength={320} defaultValue={editing === "new" ? "" : editing.email ?? ""} className="input" /></div>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm"><input id="confirmed" name="confirmed" type="checkbox" defaultChecked={editing === "new" ? false : editing.confirmed} className="h-4 w-4" /> Confirmed</label>
          </ActionForm>
          {editing !== "new" && (
            <div className="mt-4 border-t border-line pt-4">
              <ActionForm action={deleteStaffRecordAction.bind(null, editing.id)} submitLabel="Remove from the Register" variant="danger"
                confirm={`Remove ${editing.employeeCode} from the Register? The person's profile keeps the details it already has.`} />
            </div>
          )}
        </Card>
      )}

      {manage && <Card title="Upload to the Register" className="mb-6" description="Excel (.xlsx) or CSV. First row: Employee code, Pay grade, Employment date (DD/MM/YYYY), Confirmation (Confirmed or Not confirmed) and, optionally, Email. A code already here is updated.">
        <ActionForm action={importStaffRecordsAction} submitLabel="Upload" encType="multipart/form-data" resetOnSuccess confirm="Upload to the Register? Profiles of employees who have signed in are updated at once.">
          <label htmlFor="sheet" className="label">Spreadsheet</label>
          <input id="sheet" name="sheet" type="file" required accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input py-1.5" />
          <p className="hint"><a href={TEMPLATE} download="register-template.csv" className="link">Download a template</a> with the headings in place. Dates are read day first. If Excel on your computer is set to US dates, writing them as 02 Mar 2015 keeps the day and month from being switched.</p>
        </ActionForm>
      </Card>}

      <Tabs base="/admin/register" active={tab} tabs={[{ key: "all", label: "All", count: all.length }, { key: "linked", label: "Signed in", count: pick("linked").length }, { key: "waiting", label: "Not signed in yet", count: pick("waiting").length }, { key: "unconfirmed", label: "Not confirmed", count: pick("unconfirmed").length }]} />
      <Card bodyClassName="p-5" className="min-w-0">
        <SearchFilter q={sp.q} placeholder="Search code, email, pay grade or name" hidden={{ tab }} />
        {pg.items.length === 0 ? <EmptyState title={all.length ? "Nothing found" : "The Register is empty"} description={all.length ? "Try a different search or tab." : "Upload the spreadsheet above to add them."} /> : (
          <Table caption="Register">
            <thead><tr><Th>Employee code</Th><Th>Employee</Th><Th>Pay grade</Th><Th>Employment date</Th><Th>Length of service</Th><Th>Confirmation</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {pg.items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs">{r.employeeCode}</Td>
                  <Td>{r.person ? <>{r.person.name}<p className="text-xs text-muted">{r.person.email}</p></> : <span className="text-muted">Not signed in yet{r.email ? <span className="block text-xs">{r.email}</span> : null}</span>}</Td>
                  <Td>{r.payGrade}</Td>
                  <Td><DateText value={r.employmentDate} /></Td>
                  <Td>{monthsText(monthsBetween(r.employmentDate, today))}</Td>
                  <Td>{r.confirmed ? <Badge tone="success">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>}</Td>
                  <Td right>{manage && <RowMenu label={r.employeeCode} items={[{ label: "Manage", href: `/admin/register?edit=${r.id}` }]} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/admin/register" params={{ tab, q: sp.q }} label="employees" />
      </Card>
    </>
  );
}
