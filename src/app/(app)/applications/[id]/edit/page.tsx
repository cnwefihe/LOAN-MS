import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getLoanPolicy, listOpenProducts } from "@/server/services/policies";
import { LoanPolicyPanel } from "@/components/loan-policy";
import { getApplicationDetail } from "@/server/services/applications";
import { latestPayslip } from "@/server/services/payslips";
import { PayslipUpload } from "@/components/payslip-upload";
import { payslipMonth } from "@/components/payslip-breakdown";
import { formatDate } from "@/lib/finance/dates";
import { Alert, Card, PageHeader } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { departmentOptions } from "@/server/services/staff";
import { guarantorChoices, guarantorsByEmail } from "@/server/services/guarantor-pool";

export const metadata = { title: "Edit application" };

export default async function EditApplication({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ slip?: string }> }) {
  const actor = await requireActor("application.create");
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const d = await getApplicationDetail(db, actor, id).catch(() => null);
  if (!d || !d.access.isApplicant) notFound();
  if (d.app.status !== "draft" && d.app.status !== "returned") {
    return <Alert tone="warning" title="This application can no longer be edited">It has already been submitted.</Alert>;
  }
  const products = await listOpenProducts(db);
  const departments = await departmentOptions(db);
  const slip = await latestPayslip(db, actor.userId);
  const guarantorOptions = await guarantorChoices(db, actor.email);
  const chosen = await guarantorsByEmail(db, d.app.nominatedGuarantors);
  const policy = await getLoanPolicy(db);
  return (
    <>
      <PageHeader title={`Edit ${d.app.reference}`} crumbs={[{ label: "My applications", href: "/applications" }, { label: d.app.reference, href: `/applications/${id}` }, { label: "Edit" }]} />
      <LoanPolicyPanel title={policy.title} body={policy.body} className="mb-6" />
      <Card title="Your payslip" description="Eligibility is worked out from your latest payslip." className="mb-6">
        <PayslipUpload current={slip && sp.slip === slip.id ? { id: slip.id, period: slip.period, uploadedOn: formatDate(slip.createdAt) } : null} previous={slip && sp.slip !== slip.id ? (slip.period ? payslipMonth(slip.period) : "most recent") : null} />
      </Card>
      <Card>
        <ApplicationForm guarantorOptions={guarantorOptions} departments={departments} departmentId={d.applicant.profile?.departmentId ?? null} applicant={{ name: d.applicant.user.displayName, email: d.applicant.user.email, staffNumber: d.applicant.profile?.staffNumber, payGrade: d.applicant.profile?.payGrade, school: d.applicant.school?.name, department: d.applicant.department?.name, designation: d.applicant.profile?.designation, employmentStatus: d.applicant.profile?.employmentStatus, serviceMonths: d.applicant.serviceMonths, bank: d.applicant.profile?.bankAccountLast4 ? `${d.applicant.profile.bankName} ••••${d.applicant.profile.bankAccountLast4}` : null, phone: d.applicant.profile?.phone, residentialAddress: d.applicant.profile?.residentialAddress }} applicationId={id} products={products}
          initial={{ productId: d.app.productId, advanceType: d.app.advanceType, requestedAmount: d.app.requestedAmount, tenorMonths: d.app.tenorMonths, purpose: d.app.purpose, guarantors: d.app.nominatedGuarantors.map((e) => chosen.get(e.toLowerCase())?.id ?? "") }} />
      </Card>
    </>
  );
}
