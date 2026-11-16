import { getDb } from "@/db";
import { designationOf } from "@/lib/designation";
import { requireActor } from "@/lib/auth/session";
import { getLoanPolicy, listOpenProducts } from "@/server/services/policies";
import { LoanPolicyPanel } from "@/components/loan-policy";
import { departmentOptions, getStaffRecord } from "@/server/services/staff";
import { Alert, Card, PageHeader } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { latestPayslip } from "@/server/services/payslips";
import { PayslipUpload } from "@/components/payslip-upload";
import { payslipMonth } from "@/components/payslip-breakdown";
import { formatDate } from "@/lib/finance/dates";
import { guarantorChoices } from "@/server/services/guarantor-pool";

export const metadata = { title: "New application" };

export default async function NewApplication({ searchParams }: { searchParams: Promise<{ productId?: string; amount?: string; tenor?: string; advanceType?: string; slip?: string }> }) {
  const actor = await requireActor("application.create");
  const sp = await searchParams;
  const db = await getDb();
  const products = await listOpenProducts(db);
  const rec = await getStaffRecord(db, actor.userId);
  const departments = await departmentOptions(db);
  const slip = await latestPayslip(db, actor.userId);
  const guarantorOptions = await guarantorChoices(db, actor.email);
  const policy = await getLoanPolicy(db);
  return (
    <>
      <PageHeader title="New application" crumbs={[{ label: "My applications", href: "/applications" }, { label: "New" }]}
        description="Save a draft, then review and submit." />
      {!rec.profile?.bankAccountLast4 && (
        <div className="mb-4"><Alert tone="info" title="Add your bank details">The Bursary needs your salary bank account to disburse the loan. <a className="link" href="/profile">Update your profile</a>.</Alert></div>
      )}
      <LoanPolicyPanel title={policy.title} body={policy.body} open className="mb-6" />
      <Card title="Your payslip" description="Eligibility is worked out from your latest payslip." className="mb-6">
        <PayslipUpload current={slip && sp.slip === slip.id ? { id: slip.id, period: slip.period, uploadedOn: formatDate(slip.createdAt) } : null} previous={slip && sp.slip !== slip.id ? (slip.period ? payslipMonth(slip.period) : "most recent") : null} />
      </Card>
      <Card>
        {products.length ? (
          <ApplicationForm guarantorOptions={guarantorOptions} departments={departments} departmentId={rec.profile?.departmentId ?? null} applicant={{ name: rec.user.displayName, email: rec.user.email, staffNumber: rec.profile?.staffNumber, payGrade: rec.profile?.payGrade, school: rec.school?.name, department: rec.department?.name, designation: designationOf(rec.profile), employmentStatus: rec.profile?.employmentStatus, serviceMonths: rec.serviceMonths, bank: rec.profile?.bankAccountLast4 ? `${rec.profile.bankName} ••••${rec.profile.bankAccountLast4}` : null, phone: rec.profile?.phone, residentialAddress: rec.profile?.residentialAddress }} applicationId={null} products={products}
            initial={{ productId: sp.productId, advanceType: sp.advanceType, requestedAmount: sp.amount, tenorMonths: sp.tenor ? Number(sp.tenor) : undefined }} />
        ) : <Alert tone="warning" title="No loan products are open for applications">Please check back later.</Alert>}
      </Card>
    </>
  );
}
