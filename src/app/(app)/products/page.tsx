import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listOpenProducts, requiredDocsLabels } from "@/server/services/policies";
import type { PolicyParameters } from "@/lib/finance/policy";
import { serviceLength } from "@/lib/finance/dates";
import { Card, PageHeader, EmptyState, KeyValues } from "@/components/ui";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Loans and advances" };

/** "Confirmed members of staff", or "Confirmed, probation and contract members of staff" when a product is open more widely. */
function staffLabel(statuses: readonly string[]) {
  const names = statuses.map((s) => s.replace("_", " "));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `${list[0].toUpperCase()}${list.slice(1)} members of staff`;
}

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/** Required documents, one per line. */
function DocList({ docs }: { docs: string[] }) {
  if (!docs.length) return <>None required.</>;
  return <ul className="list-disc space-y-0.5 pl-5">{docs.map((d) => <li key={d}>{d}</li>)}</ul>;
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** The headline facts and the detailed terms for a loan. */
function loanFacts(x: PolicyParameters, docs: string[]) {
  const headline: [string, React.ReactNode, string][] = [
    ["Amount", "Set by your payslip", `Repayments within ${x.maxDeductionPercent}% of net pay`],
    ["Interest", x.interestMethod === "interest_free" ? "None" : `${x.annualInterestRate}% a year`, x.interestMethod === "interest_free" ? "Interest-free" : x.interestMethod === "flat" ? "On the original loan amount" : "On the reducing balance"],
    ["Tenor", x.minTenorMonths === x.maxTenorMonths ? months(x.maxTenorMonths) : `${x.minTenorMonths} to ${monthsText(x.maxTenorMonths)}`, "Deducted monthly from salary"],
  ];
  const terms: [string, React.ReactNode][] = [
    ["How much you may borrow", `Based on your latest payslip. Your total monthly deductions, including this loan, are subject to a maximum of ${x.maxDeductionPercent}% of net pay.`],
    ["Who may apply", `${staffLabel(x.eligibleEmploymentStatuses)}, subject to verification by Human Resources.`],
    ["Guarantors", x.requiredGuarantors
      ? `${x.requiredGuarantors === 2 ? "Two" : "One"}${x.guarantorMustBeConfirmed ? " confirmed" : ""} ${x.requiredGuarantors === 1 ? "member" : "members"} of staff, each with a minimum of ${serviceLength(x.guarantorMinServiceMonths)} of service.`
      : "Not required."],
    ["Repayment date", `The ${ordinal(x.repaymentDayOfMonth)} of each month${x.gracePeriodMonths ? `, beginning after ${months(x.gracePeriodMonths)}` : ""}.`],
    ["Documents", <DocList key="d" docs={docs} />],
    ["Repayment", "Equal monthly instalments of principal and interest, deducted from salary over the tenor you choose."],
  ];
  return { headline, terms };
}

/** The headline facts and the detailed terms for an advance against pay. */
function advanceFacts(x: PolicyParameters, docs: string[]) {
  const headline: [string, React.ReactNode, string][] = [
    ["Amount", "Part payment", "Salary, leave allowance or 13th month"],
    ["Interest", "None", "Interest-free"],
    ["Recovery", "One deduction", "From that payment"],
  ];
  const terms: [string, React.ReactNode][] = [
    ["How much you may request", <ul key="r" className="list-disc space-y-1 pl-5">
      <li>Salary: a part payment from your net pay.</li>
      <li>Leave allowance or 13th month pay: a part payment from one month&apos;s basic salary.</li>
    </ul>],
    ["Who may apply", `${staffLabel(x.eligibleEmploymentStatuses)}, subject to verification by Human Resources.`],
    ["Recovery", "Deducted in full from that payment."],
    ["Documents", <DocList key="d" docs={docs} />],
  ];
  return { headline, terms };
}

export default async function Products() {
  await requireActor("application.create");
  const db = await getDb();
  const products = await listOpenProducts(db);
  const docs = await requiredDocsLabels(db);
  return (
    <>
      <PageHeader title="Loans and advances" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Loans and advances" }]}
        description="Compare what is available before you apply." />
      {products.length === 0 ? <EmptyState title="Nothing is open for applications at present" description="Please check again later or contact the Bursary." /> : (
        <div className={`grid gap-6 ${products.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {products.map((p) => {
            const x = p.params;
            const required = docs.filter((d) => d.productId === null || d.productId === p.id).map((d) => d.label);
            const isAdvance = x.productType === "advance";
            const { headline, terms } = isAdvance ? advanceFacts(x, required) : loanFacts(x, required);
            return (
              <Card key={p.id} title={<span className="text-base">{p.name}</span>} description={p.description ?? undefined}>
                <div className="-mx-5 -mt-5 mb-5 grid grid-cols-3 divide-x divide-line border-b border-line bg-brand-50/60">
                  {headline.map(([k, v, note]) => (
                    <div key={k} className="px-5 py-4">
                      <p className="text-[13px] font-medium text-slate-700">{k}</p>
                      <p className="tabular mt-1 text-base font-semibold text-navy">{v}</p>
                      <p className="text-xs text-muted">{note}</p>
                    </div>
                  ))}
                </div>
                <KeyValues columns={products.length > 1 ? 2 : 3} size="lg" items={terms} />
                <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
                  <Link href={`/applications/new?productId=${p.id}`} className="btn-primary">Apply</Link>
                  <Link href={`/eligibility?productId=${p.id}`} className="btn-secondary">{isAdvance ? "Preview advance" : "Check eligibility"}</Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
