import { ActionForm } from "./action-form";
import { Field, KeyValues, Money } from "./ui";
import { GuarantorChoice, ProductChoice } from "./product-choice";
import { validTenors } from "@/lib/finance/calculator";
import { saveApplicationAction } from "@/app/actions/applicant";
import type { PolicyParameters } from "@/lib/finance/policy";
import { monthsText } from "@/lib/finance/dates";

interface Product { id: string; name: string; description: string | null; params: PolicyParameters }

export interface ApplicantSummary { name: string; email: string; staffNumber?: string | null; payGrade?: string | null; school?: string | null; department?: string | null; designation?: string | null; employmentStatus?: string | null; serviceMonths: number; bank?: string | null; phone?: string | null; residentialAddress?: string | null }

/** A department; the application is routed to its approver automatically. */
export interface DepartmentOption { id: string; name: string }

export function ApplicationForm({ products, initial, applicationId, applicant, departments, departmentId, guarantorOptions }: {
  applicant: ApplicantSummary;
  /** The eligible guarantors, by name only. */
  guarantorOptions: { id: string; name: string }[];
  departments: DepartmentOption[];
  departmentId: string | null;
  products: Product[];
  initial: { productId?: string; advanceType?: string | null; requestedAmount?: string; tenorMonths?: number; purpose?: string; guarantors?: string[] };
  applicationId: string | null;
}) {
  const selected = products.find((p) => p.id === initial.productId) ?? products[0];
  return (
    <ActionForm action={saveApplicationAction.bind(null, applicationId)} submitLabel={applicationId ? "Save changes" : "Save draft and continue"}>
      <div className="space-y-8">
        <section aria-labelledby="s0">
          <h2 id="s0" className="text-sm font-semibold text-navy">1. Applicant details</h2>
          <p className="mt-1 text-xs text-muted">Name, employee code, pay grade and bank details can be updated on <a className="link" href="/profile">My profile</a>; other details come from your Human Resources record.</p>
          <div className="mt-3 rounded-md border border-line bg-slate-50 p-4">
            <KeyValues columns={3} items={[
              ["Name", applicant.name], ["Email", applicant.email], ["Staff number", applicant.staffNumber ?? "Not recorded"],
              ["School", applicant.school ?? "Not recorded"], ["Designation", applicant.designation ?? "Not recorded"], ["Pay grade", applicant.payGrade ?? "Not recorded"],
              ["Employment status", applicant.employmentStatus?.replace("_", " ") ?? "Not recorded"], ["Length of service", `${monthsText(applicant.serviceMonths)}`], ["Salary account", applicant.bank ?? "Not provided"],
            ]} />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Department" htmlFor="departmentId" className="sm:col-span-3">
              <select id="departmentId" name="departmentId" required defaultValue={departmentId ?? ""} className="input">
                <option value="" disabled>Choose your department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Telephone number" htmlFor="phone"><input id="phone" name="phone" required autoComplete="tel" defaultValue={applicant.phone ?? ""} className="input" /></Field>
            <Field label="Residential address" htmlFor="residentialAddress" className="sm:col-span-2"><input id="residentialAddress" name="residentialAddress" required autoComplete="street-address" maxLength={300} defaultValue={applicant.residentialAddress ?? ""} className="input" /></Field>
          </div>
        </section>
        <section aria-labelledby="s1">
          <h2 id="s1" className="text-sm font-semibold text-navy">2. What you are applying for</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ProductChoice productId={selected?.id} advanceType={initial.advanceType} tenor={initial.tenorMonths}
              products={products.map((p) => ({
                id: p.id, isAdvance: p.params.productType === "advance", tenors: validTenors(p.params), guarantors: p.params.requiredGuarantors,
                label: p.params.productType === "advance" ? `${p.name}: interest-free` : `${p.name}: ${p.params.interestMethod === "interest_free" ? "interest-free" : `${p.params.annualInterestRate}% a year`}, up to ${monthsText(p.params.maxTenorMonths)}`,
              }))} />
            <Field label="Amount requested (₦)" htmlFor="requestedAmount" hint="Worked out from your payslip; the eligibility calculator shows the most you may request.">
              <input id="requestedAmount" name="requestedAmount" inputMode="decimal" required defaultValue={initial.requestedAmount} className="input" />
            </Field>
            <Field label="Purpose of the loan" htmlFor="purpose" className="sm:col-span-2" hint="State clearly what the loan is for.">
              <textarea id="purpose" name="purpose" rows={3} required minLength={10} maxLength={1000} defaultValue={initial.purpose} className="input" />
            </Field>
          </div>
        </section>

        <GuarantorChoice initialCount={selected?.params.productType === "advance" ? 0 : selected?.params.requiredGuarantors ?? 0} options={guarantorOptions} initial={initial.guarantors ?? []}>
            <h2 id="s3" className="text-sm font-semibold text-navy">3. Guarantors</h2>
            <p className="mt-1 text-xs text-muted">
              Choose two managerial staff you have spoken with; each receives your request when you submit.
              {selected ? ` Each must be confirmed, with ${selected.params.guarantorMinServiceMonths} months' service and employment beyond your final repayment, deductions within ${selected.params.guarantorMaxDeductionPercent}% of net pay, and no more than ${selected.params.maxGuaranteesPerGuarantor} active guarantees.` : ""}
            </p>
        </GuarantorChoice>
        <p className="text-xs text-muted">Next, upload your documents and submit.</p>
      </div>
    </ActionForm>
  );
}
