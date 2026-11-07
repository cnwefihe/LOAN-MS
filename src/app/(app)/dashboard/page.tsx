import Link from "next/link";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, loanAccounts, scheduleInstalments, repaymentSchedules, applicationGuarantors, notifications, loanProducts } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { buildNav } from "@/lib/nav";
import { dec } from "@/lib/finance/money";
import { instalmentLabel } from "@/lib/finance/calculator";
import { Card, PageHeader, Stat, StatGrid, Money, DateText, StatusBadge, EmptyState, Progress, Table, Td } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { monthsText } from "@/lib/finance/dates";
import { ApprovalOverview, OverviewHeading } from "@/components/approval-overview";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const actor = await requireActor();
  const db = await getDb();
  const loans = await db.select({ loan: loanAccounts, product: loanProducts.name }).from(loanAccounts).innerJoin(loanProducts, eq(loanProducts.id, loanAccounts.productId))
    .where(eq(loanAccounts.borrowerId, actor.userId)).orderBy(desc(loanAccounts.createdAt));
  const live = loans.filter((l) => ["active", "overdue", "defaulted", "pending_disbursement"].includes(l.loan.status));
  const apps = await db.select({ app: loanApplications, product: loanProducts.name }).from(loanApplications).innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .where(eq(loanApplications.applicantId, actor.userId)).orderBy(desc(loanApplications.updatedAt)).limit(5);
  const inProgress = apps.filter((a) => ["draft", "pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "returned"].includes(a.app.status));
  const nextDue = live.length
    ? (await db.select({ i: scheduleInstalments, acct: loanAccounts.accountNumber }).from(scheduleInstalments)
        .innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
        .innerJoin(loanAccounts, eq(loanAccounts.id, scheduleInstalments.loanAccountId))
        .where(and(eq(loanAccounts.borrowerId, actor.userId), eq(repaymentSchedules.isCurrent, true), inArray(scheduleInstalments.status, ["pending", "partial", "overdue"])))
        .orderBy(asc(scheduleInstalments.dueDate)).limit(1))[0]
    : undefined;
  const guaranteeRequests = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors).where(and(eq(applicationGuarantors.guarantorId, actor.userId), inArray(applicationGuarantors.status, ["pending", "clarification_requested"])));
  const recent = await db.select().from(notifications).where(eq(notifications.userId, actor.userId)).orderBy(desc(notifications.createdAt)).limit(5);
  const { sections, overview } = await buildNav(db, actor);
  const workspaces = sections.filter((s) => s.title !== "Self-service").flatMap((s) => s.items.filter((i) => i.badge !== undefined && i.href !== "/guarantor").map((i) => ({ ...i, section: s.title })));
  const waiting = workspaces.reduce((n, i) => n + (i.badge ?? 0), 0);
  const subtitle = !workspaces.length ? "Your loans, applications and guarantees."
    : overview ? "Your approvals and your own loans."
    : waiting ? `${waiting} ${waiting === 1 ? "item needs" : "items need"} your attention.` : "Nothing needs your attention today.";
  // Approvers with no loans of their own do not need empty panels under their approvals.
  const compact = overview && !apps.length && !live.length;
  const outstanding = live.reduce((acc, l) => acc.plus(l.loan.principalOutstanding).plus(l.loan.interestOutstanding), dec(0));

  const myStats = (
      <StatGrid>
        <Stat label="Outstanding balance" value={<Money value={outstanding.toFixed(2)} />} hint={`${live.length} live loan(s)`} tone="brand" href="/loans" />
        <Stat label="Next repayment" value={nextDue ? <Money value={dec(nextDue.i.totalDue).minus(nextDue.i.principalPaid).minus(nextDue.i.interestPaid).toFixed(2)} /> : "N/A"} hint={nextDue ? <>Due <DateText value={nextDue.i.dueDate} /> · {nextDue.acct}</> : "Nothing due"} tone={nextDue?.i.status === "overdue" ? "danger" : "default"} />
        <Stat label="Applications in progress" value={inProgress.length} hint={inProgress.length ? "Being processed" : "None in progress"} href="/applications" />
        <Stat label="Guarantor requests" value={guaranteeRequests.length} hint={guaranteeRequests.length ? "Awaiting your response" : "None pending"} tone={guaranteeRequests.length ? "warning" : "default"} href={actor.permissions.has("guarantee.view_own") ? "/guarantor" : undefined} />
      </StatGrid>
  );
  const notices = (
        <Card title="Latest notifications" className="h-full" actions={<Link href="/notifications" className="link text-sm">View all</Link>}>
          {recent.length === 0 ? <p className="text-sm text-muted">You have no notifications.</p> : (
            <Table caption="Latest notifications">
              <tbody>
                {recent.map((n) => (
                  <tr key={n.id}>
                    <Td>
                      <p className={n.readAt ? "text-sm" : "text-sm font-semibold"}>{n.link ? <Link href={n.link} className="hover:underline">{n.title}</Link> : n.title}</p>
                      <p className="text-xs text-muted"><DateText value={n.createdAt} withTime /></p>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
  );

  return (
    <>
      <PageHeader title={overview ? "Overview" : `Welcome, ${actor.displayName.split(" ")[0]}`} description={subtitle}
        actions={<><Link href="/eligibility" className="btn-secondary h-8 px-3 text-xs">Check eligibility</Link><Link href="/applications/new" className="btn-primary h-8 px-3 text-xs">New application</Link></>} />

      {overview && <ApprovalOverview db={db} actor={actor} aside={notices}><OverviewHeading>My loans</OverviewHeading>{myStats}</ApprovalOverview>}
      {!overview && workspaces.length > 0 && (
        <Card title="Your work" className="mb-6">
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((w) => (
              <li key={w.href}>
                <Link href={w.href} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm hover:border-brand">
                  <span><span className="block text-xs text-muted">{w.section}</span>{w.label}</span>
                  <span className={`tabular rounded-full px-2 py-0.5 text-xs font-semibold ${w.badge ? "bg-amber-100 text-warning-ink" : "bg-slate-100 text-muted"}`}>{w.badge}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}


      {!overview && myStats}

      <div className={`grid gap-6 ${overview ? "" : "lg:grid-cols-3"}`}>
        {!compact && <div className={`space-y-6 ${overview ? "" : "lg:col-span-2"}`}>
          <Card title="Recent applications" actions={<Link href="/applications" className="link text-sm">All applications</Link>}>
            {apps.length === 0 ? (
              <EmptyState title="No applications yet" description="Check your eligibility, then apply." action={<Link href="/applications/new" className="btn-primary">Start an application</Link>} />
            ) : (
              <ul className="space-y-4">
                {apps.map(({ app, product }) => (
                  <li key={app.id} className="rounded-md border border-line p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Link href={`/applications/${app.id}`} className="link">{app.reference}</Link>
                        <span className="ml-2 text-xs text-muted">{product} · <Money value={app.requestedAmount} /></span>
                      </div>
                      <StatusBadge status={app.status} />
                    </div>
                    <LifecycleTracker applicantId={app.applicantId} appStatus={app.status} level={app.currentApprovalLevel} loanStatus={loans.find((l) => l.loan.applicationId === app.id)?.loan.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Active loans" actions={<Link href="/loans" className="link text-sm">All loans</Link>}>
            {live.length === 0 ? (
              <EmptyState title="No active loans" description="Your loans will appear here once they have been disbursed." />
            ) : (
              <ul className="space-y-5">
                {live.map(({ loan, product }) => {
                  const repaid = dec(loan.totalRepaid);
                  const pct = dec(loan.totalRepayable).isZero() ? 0 : repaid.div(loan.totalRepayable).times(100).toNumber();
                  return (
                    <li key={loan.id} className="rounded-md border border-line p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <Link href={`/loans/${loan.id}`} className="link">{loan.accountNumber}</Link>
                          <p className="text-xs text-muted">{product} · <Money value={loan.principal} /> over {monthsText(loan.tenorMonths)}</p>
                        </div>
                        <StatusBadge status={loan.status} />
                      </div>
                      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                        <div><p className="text-xs text-muted">Outstanding</p><Money value={dec(loan.principalOutstanding).plus(loan.interestOutstanding).toFixed(2)} className="font-semibold" /></div>
                        <div><p className="text-xs text-muted">{instalmentLabel(loan.repaymentPeriodMonths)}</p><Money value={loan.monthlyInstalment} /></div>
                        <div><p className="text-xs text-muted">Expected completion</p><DateText value={loan.maturityDate} /></div>
                      </div>
                      {loan.status !== "pending_disbursement" && <div className="mt-3"><Progress value={pct} label="Repaid (confirmed)" /></div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

        </div>}
        {!overview && notices}
      </div>
    </>
  );
}
