import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getLoanPolicy, listOpenProducts, requiredDocsLabels } from "@/server/services/policies";
import type { PolicyParameters } from "@/lib/finance/policy";
import { Card, PageHeader, EmptyState, Tabs } from "@/components/ui";
import { monthsText } from "@/lib/finance/dates";
import { RichText } from "@/components/rich-text";
import { productSummary, whoMayApply } from "@/lib/finance/product-summary";

export const metadata = { title: "Loans and advances" };


const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/** Required documents, one per line. */
function DocList({ docs }: { docs: string[] }) {
  if (!docs.length) return <>None required.</>;
  return <ul className="list-disc space-y-0.5 pl-5">{docs.map((d) => <li key={d}>{d}</li>)}</ul>;
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

type Panel = [string, [string, React.ReactNode][]];

/**
 * Two panels of terms side by side: the label on the left of each row and the text beside it. On wide
 * screens both panels share one set of rows, so the rows at the same level are the same height and line up.
 */
function TermsPanels({ panels }: { panels: Panel[] }) {
  const rows = Math.max(...panels.map(([, r]) => r.length));
  return (
    <div className="grid gap-5 xl:grid-cols-2 xl:gap-y-0" style={{ "--rows": rows + 1 } as React.CSSProperties}>
      {panels.map(([title, items]) => (
        <section key={title} aria-label={title} className="min-w-0 overflow-hidden rounded-lg border border-line xl:row-span-(--rows) xl:grid xl:grid-rows-subgrid">
          <h3 className="border-b border-line bg-slate-50 px-4 py-2.5 text-sm font-semibold text-navy">{title}</h3>
          <dl className="divide-y divide-line xl:contents">
            {items.map(([k, v]) => (
              <div key={k} className="grid gap-1 border-line px-4 py-3 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-4 xl:border-b xl:last:border-b-0">
                <dt className="text-sm font-semibold text-ink">{k}</dt>
                <dd className="break-words text-sm leading-relaxed text-slate-600">{v}</dd>
              </div>
            ))}
            {Array.from({ length: rows - items.length }, (_, i) => <div key={`pad-${i}`} aria-hidden className="hidden xl:block" />)}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The headline facts and the detailed terms for a loan. */
function loanFacts(x: PolicyParameters, docs: string[]) {
  const free = x.interestMethod === "interest_free";
  const headline: [string, React.ReactNode, string][] = [
    ["Amount", "Set by your payslip", `Within ${x.maxDeductionPercent}% of net pay`],
    ["Interest", free ? "None" : `${x.annualInterestRate}% a year`, free ? "Interest-free" : x.interestMethod === "flat" ? "On the original amount" : "On the reducing balance"],
    ["Tenor", x.minTenorMonths === x.maxTenorMonths ? months(x.maxTenorMonths) : `${x.minTenorMonths} to ${monthsText(x.maxTenorMonths)}`, "Monthly salary deduction"],
  ];
  const eligibility: [string, React.ReactNode][] = [
    ["Amount", `Set by your latest payslip. Total deductions, including this loan, within ${x.maxDeductionPercent}% of net pay.`],
    ["Who may apply", whoMayApply(x)],
    ["Purpose", "Stated clearly on the application form."],
    ["Guarantors", x.requiredGuarantors
      ? `${x.requiredGuarantors === 2 ? "Two" : "One"} colleague: confirmed, with ${months(x.guarantorMinServiceMonths)}' service and deductions within ${x.guarantorMaxDeductionPercent}% of net pay.`
      : "Not required."],
    ["Documents", <DocList key="d" docs={docs} />],
  ];
  const repayment: [string, React.ReactNode][] = [
    ["Payment", "Credited to your salary account, subject to available funds."],
    ["Repayment", `Equal monthly salary deductions over up to ${monthsText(x.maxTenorMonths)}; automatic after the first is confirmed.`],
    ["Due date", `The ${ordinal(x.repaymentDayOfMonth)} of each month, from the month after payout${x.gracePeriodMonths ? ` plus ${months(x.gracePeriodMonths)}` : ""}.`],
    ["Early repayment", free ? "Any time: principal less repayments made." : "Any time: principal plus interest to date, less repayments made."],
    ["Leaving the University", `Balance deducted from final pay, or payable by you${x.requiredGuarantors ? " or your guarantors" : ""}.`],
    ["Another loan", "Only after this one is fully repaid."],
  ];
  return { headline, panels: [["Eligibility", eligibility], ["Repayment", repayment]] as Panel[] };
}

/** The headline facts and the detailed terms for an advance against pay. */
function advanceFacts(x: PolicyParameters, docs: string[]) {
  const headline: [string, React.ReactNode, string][] = [
    ["Amount", "Part payment", "Salary, leave allowance or 13th month"],
    ["Interest", "None", "Interest-free"],
    ["Recovery", "One deduction", "From that payment"],
  ];
  const eligibility: [string, React.ReactNode][] = [
    ["Amount", <ul key="r" className="list-disc space-y-1 pl-5">
      <li>Salary: part of your net pay.</li>
      <li>Leave allowance or 13th month: part of one month&apos;s basic salary.</li>
    </ul>],
    ["Who may apply", whoMayApply(x)],
    ["Documents", <DocList key="d" docs={docs} />],
  ];
  const recovery: [string, React.ReactNode][] = [
    ["Recovery", "In full from that payment."],
    ["Interest", "None."],
    ["Guarantors", "Not required."],
  ];
  return { headline, panels: [["Eligibility", eligibility], ["Recovery", recovery]] as Panel[] };
}

export default async function Products({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireActor("application.create");
  const sp = await searchParams;
  const db = await getDb();
  const products = await listOpenProducts(db);
  const docs = await requiredDocsLabels(db);
  const policy = await getLoanPolicy(db);
  const key = (code: string) => code.toLowerCase();
  // One product at a time, chosen from the tabs; the loan policy has its own tab.
  const tab = sp.tab === "policy" || products.some((p) => key(p.code) === sp.tab) ? sp.tab! : products[0] ? key(products[0].code) : "policy";
  const p = products.find((x) => key(x.code) === tab);
  return (
    <>
      <PageHeader title="Loans and advances" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Loans and advances" }]}
        description="Choose a product to see its terms before you apply." />
      {products.length === 0 && <div className="mb-6"><EmptyState title="Nothing is open for applications at present" description="Please check again later or contact the Bursary." /></div>}
      <Tabs base="/products" active={tab} tabs={[...products.map((x) => ({ key: key(x.code), label: x.name })), { key: "policy", label: "Loan policy" }]} />
      {p ? (() => {
        const x = p.params;
        const required = docs.filter((d) => d.productId === null || d.productId === p.id).map((d) => d.label);
        const isAdvance = x.productType === "advance";
        const { headline, panels } = isAdvance ? advanceFacts(x, required) : loanFacts(x, required);
        return (
          <Card title={<span className="text-base">{p.name}</span>} description={<>{productSummary(x)}{p.description ? <span className="mt-1 block">{p.description}</span> : null}</>}
            actions={<>
              <Link href={`/eligibility?productId=${p.id}`} className="btn-secondary">{isAdvance ? "Preview advance" : "Check eligibility"}</Link>
              <Link href={`/applications/new?productId=${p.id}`} className="btn-primary">Apply</Link>
            </>}>
            <div className="-mx-5 -mt-5 mb-5 grid grid-cols-1 divide-y divide-line border-b border-line bg-brand-50/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {headline.map(([k, v, note]) => (
                <div key={k} className="min-w-0 px-5 py-3.5">
                  <p className="text-[13px] font-medium text-slate-700">{k}</p>
                  <p className="tabular mt-0.5 text-base font-semibold text-navy">{v}</p>
                  <p className="text-xs text-muted">{note}</p>
                </div>
              ))}
            </div>
            <TermsPanels panels={panels} />
          </Card>
        );
      })() : (
        <Card title={policy.title} description="The University's policy on staff loans. It applies to every product.">
          <div className="gap-10 text-sm leading-relaxed text-slate-700 xl:columns-2 [&_h3]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-navy [&_section]:mb-5 [&_section]:break-inside-avoid">
            <RichText text={policy.body} headingLevel={3} />
          </div>
        </Card>
      )}
    </>
  );
}
