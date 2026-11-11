import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getLoanPolicy, listOpenProducts, requiredDocsLabels } from "@/server/services/policies";
import type { PolicyParameters } from "@/lib/finance/policy";
import { Card, PageHeader, EmptyState } from "@/components/ui";
import { monthsText } from "@/lib/finance/dates";
import { RichText } from "@/components/rich-text";

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
    ["Purpose", "State clearly on the application form what the loan is for."],
    ["Guarantors", x.requiredGuarantors
      ? `${x.requiredGuarantors === 2 ? "Two guarantors" : "One guarantor"} from the managerial cadre, chosen from the list when you apply. Each must be a confirmed employee with at least ${months(x.guarantorMinServiceMonths)} of continuous service, and their deductions, with their share of this loan, must stay within ${x.guarantorMaxDeductionPercent}% of their net pay.`
      : "Not required."],
    ["Repayment", `Equal monthly ${x.interestMethod === "interest_free" ? "instalments" : "instalments of principal and interest"}, deducted from salary over the tenor you choose, up to ${monthsText(x.maxTenorMonths)}. After the first deduction is confirmed, each later one is recorded automatically.`],
    ["Repayment date", `The ${ordinal(x.repaymentDayOfMonth)} of each month, starting the month after the loan is paid out${x.gracePeriodMonths ? `, after a further ${months(x.gracePeriodMonths)}` : ""}.`],
    ["Payment", "By direct credit to your salary account. Approval is subject to the availability of funds."],
    ["Documents", <DocList key="d" docs={docs} />],
    ["Early repayment", x.interestMethod === "interest_free"
      ? "You may repay the whole balance at any time: the loan principal less your total repayments. Part payments are taken only from salary."
      : "You may repay the whole balance at any time: the loan principal plus interest to date, less your total repayments. Interest for the remaining months is not charged. Part payments are taken only from salary."],
    ["If you leave the University", `Any outstanding balance is deducted in full from your final pay, or is payable at once by you${x.requiredGuarantors ? " or your guarantors" : ""}.`],
    ["Another loan", "Only after this loan is fully repaid."],
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
  const policy = await getLoanPolicy(db);
  const several = products.length > 1;
  return (
    <>
      <PageHeader title="Loans and advances" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Loans and advances" }]}
        description="Compare what is available before you apply." />
      {products.length === 0 ? <EmptyState title="Nothing is open for applications at present" description="Please check again later or contact the Bursary." /> : (
        // One product a row on laptop screens, so the terms have room; side by side on wide screens.
        <div className={`grid gap-6 ${several ? "2xl:grid-cols-2" : ""}`}>
          {products.map((p) => {
            const x = p.params;
            const required = docs.filter((d) => d.productId === null || d.productId === p.id).map((d) => d.label);
            const isAdvance = x.productType === "advance";
            const { headline, terms } = isAdvance ? advanceFacts(x, required) : loanFacts(x, required);
            return (
              <Card key={p.id} className="flex min-w-0 flex-col" bodyClassName="flex flex-1 flex-col p-5" title={<span className="text-base">{p.name}</span>} description={p.description ?? undefined}>
                <div className="-mx-5 -mt-5 mb-5 grid grid-cols-1 divide-y divide-line border-b border-line bg-brand-50/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  {headline.map(([k, v, note]) => (
                    <div key={k} className="min-w-0 px-5 py-4">
                      <p className="text-[13px] font-medium text-slate-700">{k}</p>
                      <p className="tabular mt-1 text-base font-semibold text-navy">{v}</p>
                      <p className="text-xs text-muted">{note}</p>
                    </div>
                  ))}
                </div>
                <dl className={`grid flex-1 content-start gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3 ${several ? "2xl:grid-cols-2" : ""}`}>
                  {terms.map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[15px] font-semibold text-ink">{k}</dt>
                      <dd className="mt-1 break-words text-sm leading-relaxed text-slate-600">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
                  <Link href={`/applications/new?productId=${p.id}`} className="btn-primary">Apply</Link>
                  <Link href={`/eligibility?productId=${p.id}`} className="btn-secondary">{isAdvance ? "Preview advance" : "Check eligibility"}</Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Card title={policy.title} description="The University's policy on staff loans. It applies to every product above." className="mt-6">
        <div className="gap-10 text-sm leading-relaxed text-slate-700 xl:columns-2 [&_h3]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-navy [&_section]:mb-5 [&_section]:break-inside-avoid">
          <RichText text={policy.body} headingLevel={3} />
        </div>
      </Card>
    </>
  );
}
