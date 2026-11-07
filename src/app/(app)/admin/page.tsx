import Link from "next/link";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users, auditLogs, policyVersions, departments, financialTransactions, loanAccounts, loanApplications, loanProducts, emailOutbox, repaymentClaims, sessions } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { connectionStatus } from "@/server/integrations/status";
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileText, Wallet, type LucideIcon } from "lucide-react";
import { Card, Money, PageHeader, DateText, Badge } from "@/components/ui";
import { getSetting } from "@/server/settings";
import { portfolioSummary } from "@/server/services/reports";
import { dec, m } from "@/lib/finance/money";
import { durationText } from "@/lib/duration";

export const metadata = { title: "Control centre" };

const DAY_MS = 86_400_000;
/** Routine sign-ins would otherwise fill the activity list. */
const SIGN_INS = ["user.signed_in", "user.dev_fixture_login", "user.signed_out"];

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const described = (action: string) => {
  const s = action.replace(/^org\./, "organisation.").replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function Kpi({ icon: Icon, label, value, hint, href, warn }: { icon: LucideIcon; label: string; value: React.ReactNode; hint: React.ReactNode; href: string; warn?: boolean }) {
  return (
    <Link href={href} className="card flex items-center gap-4 p-4 transition-colors hover:border-brand">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${warn ? "bg-warning-50 text-warning-ink" : "bg-brand-50 text-brand"}`}><Icon aria-hidden className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm text-muted">{label}</span>
        <span className="tabular block text-2xl font-semibold leading-tight text-ink">{value}</span>
        <span className="block truncate text-xs text-muted">{hint}</span>
      </span>
    </Link>
  );
}

export default async function AdminHome() {
  const actor = await requireActor("admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.settings.manage", "admin.audit.view");
  const db = await getDb();
  const n = sql<number>`count(*)`;
  const [[u], [p], [pend], [mail], [sess]] = await Promise.all([
    db.select({ n }).from(users).where(eq(users.isActive, true)),
    db.select({ n }).from(loanProducts).where(eq(loanProducts.isActive, true)),
    db.select({ n }).from(policyVersions).where(eq(policyVersions.status, "pending_approval")),
    db.select({ n }).from(emailOutbox).where(sql`${emailOutbox.status} in ('failed','not_configured')`),
    db.select({ n }).from(sessions).where(sql`${sessions.revokedAt} is null and ${sessions.expiresAt} > now()`),
  ]);
  const inApproval = await db.select({ level: loanApplications.currentApprovalLevel }).from(loanApplications).where(eq(loanApplications.status, "pending_approval"));
  const pipeline = (await db.select({ status: loanApplications.status, n }).from(loanApplications).groupBy(loanApplications.status)).map((r) => ({ status: r.status as string, n: Number(r.n) }));
  const [[awaitingPayment], [claims], [checker]] = await Promise.all([
    db.select({ n }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement")),
    db.select({ n }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId))),
    db.select({ n }).from(financialTransactions).where(eq(financialTransactions.status, "pending_approval")),
  ]);
  const overdue = await db.select({ id: loanAccounts.id }).from(loanAccounts).where(inArray(loanAccounts.status, ["overdue", "defaulted"]));
  const escalateMinutes = await getSetting(db, "reminders.escalateMinutes");
  const stuck = await db.select({ id: loanApplications.id }).from(loanApplications)
    .where(and(inArray(loanApplications.status, ["pending_hr", "pending_bursary", "pending_approval"]), lt(loanApplications.updatedAt, new Date(Date.now() - escalateMinutes * 60_000))));
  const noHead = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.isActive, true), isNull(departments.headUserId)));
  const [lastAuto] = await db.select({ at: auditLogs.createdAt }).from(auditLogs).where(and(eq(auditLogs.action, "servicing.run"), isNull(auditLogs.actorId))).orderBy(desc(auditLogs.id)).limit(1);
  const summary = await portfolioSummary(db, actor);
  const atStage = (level: number) => inApproval.filter((a) => (a.level || 1) === level).length;
  const recent = await db.select({ log: auditLogs, actorName: users.displayName }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(notInArray(auditLogs.action, SIGN_INS)).orderBy(desc(auditLogs.id)).limit(7);
  const connections = connectionStatus();
  const ready = connections.filter((c) => c.ok).length;
  const toReview = [
    { label: "Policies awaiting approval", n: Number(pend.n), href: "/admin/products" },
    { label: "Pending authorisations", n: Number(checker.n), href: "/accounts/approvals" },
    { label: `Applications waiting over ${durationText(escalateMinutes)}`, n: stuck.length, href: "/hr/applications?status=" },
    { label: "Departments with no Line Manager", n: noHead.length, href: "/admin/organisation" },
    { label: "Undelivered emails", n: Number(mail.n), href: "/admin/outbox" },
    { label: "Overdue or defaulted loans", n: overdue.length, href: "/accounts/loans?status=overdue" },
  ].filter((i) => i.n > 0);
  const autoRunning = !!lastAuto && Date.now() - lastAuto.at.getTime() < 2 * DAY_MS;
  const atStatus = (s: string) => pipeline.find((x) => x.status === s)?.n ?? 0;
  const stages = [
    { label: "Human Resources", n: atStatus("pending_hr"), href: "/hr/applications" },
    { label: "Bursary", n: atStatus("pending_bursary") },
    { label: "Line Manager", n: atStage(1), href: "/approvals" },
    { label: "HR Director", n: atStage(2), href: "/approvals" },
    { label: "Bursar", n: atStage(3), href: "/approvals" },
    { label: "Payment", n: Number(awaitingPayment.n), href: "/accounts/disbursements" },
  ];
  const inProgress = stages.reduce((sum, x) => sum + x.n, 0);
  const dot = (ok: boolean) => <span aria-hidden className={`h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-warning"}`} />;
  const mailOk = Number(mail.n) === 0;
  const system: { label: string; value: React.ReactNode; href: string; ok: boolean }[] = [
    { label: "Active users", value: Number(u.n), href: "/admin/users", ok: true },
    { label: "Active sessions", value: Number(sess.n), href: "/admin/audit?tab=sessions", ok: true },
    { label: "Open loan products", value: Number(p.n), href: "/admin/products", ok: true },
    { label: "Undelivered emails", value: Number(mail.n), href: "/admin/outbox", ok: mailOk },
    { label: "Automatic daily check", value: autoRunning ? "Running" : "Not running", href: "/accounts/servicing", ok: autoRunning },
    { label: "Connections", value: `${ready} of ${connections.length}`, href: "/admin/connections", ok: ready === connections.length },
  ];
  return (
    <>
      <PageHeader title="Control centre" description="What is happening across the system." />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={Wallet} label="Outstanding balance" value={<Money value={summary.loans.outstanding} />} hint={`${summary.loans.activeCount} active loans`} href="/accounts/loans" />
        <Kpi icon={FileText} label="Applications in progress" value={inProgress} hint="Across all stages" href="/reports" />
        <Kpi icon={AlertTriangle} label="Overdue or defaulted" value={overdue.length} hint={<Money value={m(dec(summary.loans.overdueAmount).plus(summary.loans.defaultedAmount))} />} href="/accounts/loans?status=overdue" warn={overdue.length > 0} />
        <Kpi icon={ClipboardCheck} label="Repayments to confirm" value={Number(claims.n)} hint="Reported by staff" href="/accounts/repayments" />
      </div>
      <Card title="Application progress" className="mb-6">
        <ol className="grid grid-cols-2 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
          {stages.map((x, i) => {
            const step = <>
              <span className={`tabular relative z-10 mx-auto grid h-11 w-11 place-items-center rounded-full text-base font-semibold ring-4 ring-white ${x.n ? "bg-brand text-white" : "bg-slate-100 text-slate-600"}`}>{x.n}</span>
              <span className="mt-2 block text-sm text-muted">{x.label}</span>
            </>;
            return (
              <li key={x.label} className="relative text-center">
                {i < stages.length - 1 && <span aria-hidden className="absolute left-1/2 top-[1.3rem] hidden h-0.5 w-full bg-slate-200 xl:block" />}
                {x.href ? <Link href={x.href} className="relative block hover:text-brand">{step}</Link> : <span className="relative block">{step}</span>}
              </li>
            );
          })}
        </ol>
      </Card>
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card title="Recent activity" actions={<Link href="/admin/audit" className="link text-sm">View all</Link>} className="min-w-0 xl:col-span-2" bodyClassName="p-0!">
          {recent.length ? (
            <ul className="divide-y divide-line">
              {recent.map(({ log, actorName }) => (
                <li key={log.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand">{initials(actorName ?? "System")}</span>
                  <p className="min-w-0 flex-1 truncate text-sm"><span className="font-medium text-ink">{actorName ?? "System"}</span> <span className="text-muted">{log.summary || described(log.action)}</span></p>
                  <span className="shrink-0 text-xs text-muted"><DateText value={log.createdAt} withTime /></span>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-muted">No activity yet.</p>}
        </Card>
        <div className="space-y-6">
          <Card title="To review" bodyClassName="p-0!">
            {toReview.length ? (
              <ul className="divide-y divide-line">
                {toReview.map((i) => (
                  <li key={i.label}>
                    <Link href={i.href} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-slate-50">
                      <span>{i.label}</span>
                      <Badge tone="warning">{i.n}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="flex items-center gap-2 px-5 py-3 text-sm text-muted"><CheckCircle2 aria-hidden className="h-4 w-4 text-success" />All clear</p>}
          </Card>
          <Card title="System health" bodyClassName="p-0!">
            <ul className="divide-y divide-line">
              {system.map((s) => (
                <li key={s.label}>
                  <Link href={s.href} className="flex items-center gap-2.5 px-5 py-2.5 text-sm hover:bg-slate-50">
                    {dot(s.ok)}
                    <span className="text-muted">{s.label}</span>
                    <span className="tabular ml-auto font-medium text-ink">{s.value}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
