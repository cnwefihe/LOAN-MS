import { ActionForm } from "./action-form";
import { Field, KeyValues, Money } from "./ui";
import { LoanOnly, ProductChoice } from "./product-choice";
import { validTenors } from "@/lib/finance/calculator";
import { serviceLength } from "@/lib/finance/dates";
import { saveApplicationAction } from "@/app/actions/applicant";
import type { PolicyParameters } from "@/lib/finance/policy";
import { monthsText } from "@/lib/finance/dates";

interface Product { id: string; name: string; description: string | null; params: PolicyParameters }

export interface ApplicantSummary { name: string; email: string; staffNumber?: string | null; payGrade?: string | null; school?: string | null; department?: string | null; designation?: string | null; employmentStatus?: string | null; serviceMonths: number; bank?: string | null; phone?: string | null; residentialAddress?: string | null }

/** A department; the application is routed to its approver automatically. */
export interface DepartmentOption { id: string; name: string }

export function ApplicationForm({ products, initial, applicationId, applicant, departments, departmentId }: {
  applicant: ApplicantSummary;
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
                id: p.id, isAdvance: p.params.productType === "advance", tenors: validTenors(p.params),
                label: p.params.productType === "advance" ? `${p.name}: interest-free` : `${p.name}: ${p.params.interestMethod === "interest_free" ? "interest-free" : `${p.params.annualInterestRate}% a year`}, up to ${monthsText(p.params.maxTenorMonths)}`,
              }))} />
            <Field label="Amount requested (₦)" htmlFor="requestedAmount" hint="Worked out from your payslip; the eligibility calculator shows the most you may request.">
              <input id="requestedAmount" name="requestedAmount" inputMode="decimal" required defaultValue={initial.requestedAmount} className="input" />
            </Field>
            <Field label="Purpose" htmlFor="purpose" className="sm:col-span-2">
              <textarea id="purpose" name="purpose" rows={3} required minLength={10} maxLength={1000} defaultValue={initial.purpose} className="input" />
            </Field>
          </div>
        </section>

        <LoanOnly initiallyAdvance={selected?.params.productType === "advance"}>
        <section aria-labelledby="s3">
          <h2 id="s3" className="text-sm font-semibold text-navy">3. Guarantor nomination</h2>
          <p className="mt-1 text-xs text-muted">
            Two colleagues, by university email. {selected ? `Confirmed staff, each with a minimum of ${serviceLength(selected.params.guarantorMinServiceMonths)} of service.` : ""} They are invited when you submit.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Field key={i} label={`Guarantor ${i + 1}`} htmlFor={`guarantor${i + 1}`}>
                <input id={`guarantor${i + 1}`} name={`guarantor${i + 1}`} type="email" autoComplete="off" placeholder="name@example.edu.ng" defaultValue={initial.guarantors?.[i]} className="input" />
              </Field>
            ))}
          </div>
        </section>
        </LoanOnly>
        <p className="text-xs text-muted">Next, upload your documents and submit.</p>
      </div>
    </ActionForm>
  );
}
