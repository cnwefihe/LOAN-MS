import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listOpenProducts } from "@/server/services/policies";
import { departmentOptions, getStaffRecord } from "@/server/services/staff";
import { Alert, Card, PageHeader } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { latestPayslip } from "@/server/services/payslips";
import { PayslipUpload } from "@/components/payslip-upload";
import { payslipMonth } from "@/components/payslip-breakdown";
import { formatDate } from "@/lib/finance/dates";

export const metadata = { title: "New application" };

export default async function NewApplication({ searchParams }: { searchParams: Promise<{ productId?: string; amount?: string; tenor?: string; advanceType?: string; slip?: string }> }) {
  const actor = await requireActor("application.create");
  const sp = await searchParams;
  const db = await getDb();
  const products = await listOpenProducts(db);
  const rec = await getStaffRecord(db, actor.userId);
  const departments = await departmentOptions(db);
  const slip = await latestPayslip(db, actor.userId);
  return (
    <>
      <PageHeader title="New application" crumbs={[{ label: "My applications", href: "/applications" }, { label: "New" }]}
        description="Save a draft, then review and submit." />
      {!rec.profile?.bankAccountLast4 && (
        <div className="mb-4"><Alert tone="info" title="Add your bank details">The Bursary needs your salary bank account to disburse the loan. <a className="link" href="/profile">Update your profile</a>.</Alert></div>
      )}
      <Card title="Your payslip" description="Eligibility is worked out from your latest payslip." className="mb-6">
        <PayslipUpload current={slip && sp.slip === slip.id ? { id: slip.id, period: slip.period, uploadedOn: formatDate(slip.createdAt) } : null} previous={slip && sp.slip !== slip.id ? (slip.period ? payslipMonth(slip.period) : "most recent") : null} />
      </Card>
      <Card>
        {products.length ? (
          <ApplicationForm departments={departments} departmentId={rec.profile?.departmentId ?? null} applicant={{ name: rec.user.displayName, email: rec.user.email, staffNumber: rec.profile?.staffNumber, payGrade: rec.profile?.payGrade, school: rec.school?.name, department: rec.department?.name, designation: rec.profile?.designation, employmentStatus: rec.profile?.employmentStatus, serviceMonths: rec.serviceMonths, bank: rec.profile?.bankAccountLast4 ? `${rec.profile.bankName} ••••${rec.profile.bankAccountLast4}` : null, phone: rec.profile?.phone, residentialAddress: rec.profile?.residentialAddress }} applicationId={null} products={products}
            initial={{ productId: sp.productId, advanceType: sp.advanceType, requestedAmount: sp.amount, tenorMonths: sp.tenor ? Number(sp.tenor) : undefined }} />
        ) : <Alert tone="warning" title="No loan products are open for applications">Please check back later.</Alert>}
      </Card>
    </>
  );
}
