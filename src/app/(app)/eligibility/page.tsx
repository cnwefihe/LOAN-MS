import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listOpenProducts } from "@/server/services/policies";
import { staffContext } from "@/server/services/applications";
import { guarantorExposure } from "@/server/services/guarantors";
import { latestPayslip } from "@/server/services/payslips";
import { formatDate, todayLagos } from "@/lib/finance/dates";
import { Alert, PageHeader } from "@/components/ui";
import { EligibilityCalculator } from "@/components/eligibility-calculator";

export const metadata = { title: "Eligibility calculator" };

export default async function EligibilityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireActor("application.create");
  const sp = await searchParams;
  const db = await getDb();
  const products = await listOpenProducts(db);
  const { payslipId: _, ...all } = await staffContext(db, actor.userId, { checkRecord: false });
  const latest = await latestPayslip(db, actor.userId);
  // Each visit starts afresh: only a payslip uploaded on this visit is used.
  const slip = latest && sp.slip === latest.id ? latest : null;
  const ctx = slip ? all : { ...all, payslip: null };
  const exposure = await guarantorExposure(db, actor.userId);

  return (
    <>
      <PageHeader title="Eligibility calculator" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Eligibility" }]}
        description="Upload your latest payslip to see what you can borrow." />
      {!products.length ? <Alert tone="warning" title="No loan products are currently open">Please check back later or contact the Bursary.</Alert> : (
        <EligibilityCalculator
          products={products.map((p) => ({ id: p.id, name: p.name, params: p.params }))}
          ctx={ctx}
          standing={all}
          payslipOnFile={slip ? { id: slip.id, period: slip.period, uploadedOn: formatDate(slip.createdAt) } : null}
          guarantees={exposure.items.map((g) => ({ reference: g.reference, applicantName: g.applicantName, currentExposure: g.currentExposure, monthlyCommitment: g.monthlyCommitment, monthsLeft: g.monthsLeft, disbursed: !!g.loanStatus && g.loanStatus !== "pending_disbursement" }))}
          asOf={todayLagos()}
          initial={{ productId: sp.productId, amount: sp.amount, tenor: sp.tenor }}
        />
      )}
    </>
  );
}
