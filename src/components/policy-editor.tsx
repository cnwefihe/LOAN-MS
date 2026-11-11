"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "./action-form";
import { Alert, Badge, Card, cx } from "./ui";
import type { ActionResult } from "@/server/action-result";
import { assessEligibility, validTenors } from "@/lib/finance/calculator";
import { formatNaira } from "@/lib/finance/money";
import { EMPLOYMENT_STATUSES, POLICY_FIELD_LABELS, policyParametersSchema, type PolicyParameters } from "@/lib/finance/policy";
import { monthsText } from "@/lib/finance/dates";

type Key = keyof PolicyParameters;

const N = (v: string | number | null | undefined) => formatNaira(v === undefined || v === null ? null : String(v));

const OPTIONS: Partial<Record<Key, [string, string][]>> = {
  productType: [["loan", "Loan"], ["advance", "Advance against salary or leave allowance"]],
  interestMethod: [["reducing_balance", "Reducing balance (equal monthly instalments, as Excel =PMT)"], ["flat", "Flat rate"], ["interest_free", "Interest-free"]],
  repaymentFrequency: [["monthly", "Monthly"], ["bi_monthly", "Every two months"], ["quarterly", "Quarterly"]],
};

const HINTS: Partial<Record<Key, string>> = {
  maxDeductionPercent: "Net pay is basic + medical − tax − pension − NHF from the payslip. All further deductions together (cooperative, cafeteria, other deductions and the loan) are subject to this maximum.",
  cafeteriaAmount: "Counted whenever a cafeteria deduction is on the payslip, whatever was used.",
  annualInterestRate: "Use 0 with the interest-free method.",
  maxGuarantorExposure: "The most one guarantor may guarantee across all loans.",
  gracePeriodMonths: "Months between disbursement and the first repayment.",
  overdueAfterDays: "Days after a missed due date before the loan is overdue.",
  defaultAfterDays: "Days past due before the loan is in default and guarantors are called.",
};

const GROUPS: { title: string; fields: Key[] }[] = [
  { title: "Eligibility", fields: ["productType", "minServiceMonths", "maxActiveLoans", "eligibleEmploymentStatuses"] },
  { title: "Interest", fields: ["interestMethod", "annualInterestRate"] },
  { title: "Tenor and deduction limit", fields: ["minTenorMonths", "maxTenorMonths", "maxDeductionPercent", "cafeteriaAmount"] },
  { title: "Guarantors", fields: ["requiredGuarantors", "guarantorMinServiceMonths", "guarantorMustBeConfirmed", "maxGuarantorExposure", "maxGuaranteesPerGuarantor"] },
  { title: "Repayment and arrears", fields: ["repaymentFrequency", "repaymentDayOfMonth", "gracePeriodMonths", "overdueAfterDays", "defaultAfterDays", "reminderDaysBeforeDue", "allowRestructuring", "maxRestructuredTenorMonths"] },
  { title: "Documents", fields: ["requiredDocumentCodes"] },
];

const MONEY: Key[] = ["maxGuarantorExposure", "cafeteriaAmount"];
const WIDE: Key[] = ["eligibleEmploymentStatuses", "requiredDocumentCodes"];

/** Form values as typed (strings), turned into a policy object for checking and the live example. */
function toPolicy(v: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { ...v };
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string" || OPTIONS[k as Key] || k === "requiredDocumentCodes") continue;
    const clean = x.replace(/[,₦\s]/g, "");
    out[k] = MONEY.includes(k as Key) ? clean : clean === "" ? NaN : Number(clean);
  }
  out.requiredDocumentCodes = String(v.requiredDocumentCodes ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return out;
}

export function PolicyEditor({ initial, action, productName, description }: {
  initial: PolicyParameters;
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  productName: string;
  description?: React.ReactNode;
}) {
  const [v, setV] = useState<Record<string, unknown>>(() => {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(initial)) o[k] = typeof x === "number" ? String(x) : k === "requiredDocumentCodes" ? (x as string[]).join(", ") : x;
    return o;
  });
  const [example, setExample] = useState({ gross: "450000", net: "380000", amount: "500000" });
  const set = (k: Key, x: unknown) => setV((o) => ({ ...o, [k]: x }));

  const parsed = useMemo(() => policyParametersSchema.safeParse(toPolicy(v)), [v]);
  const p = parsed.success ? parsed.data : null;
  const result = useMemo(() => {
    if (!p) return null;
    try {
      return assessEligibility({
        policy: p, salary: { basic: "0", gross: example.gross.replace(/,/g, "") || "0", net: example.net.replace(/,/g, "") || "0" },
        serviceMonths: 60, employmentStatus: "confirmed", existingMonthlyDeductions: "0", activeLoanCount: 0,
        requestedAmount: example.amount.replace(/,/g, "") || undefined, asOf: new Date().toISOString().slice(0, 10),
      });
    } catch { return null; }
  }, [p, example]);

  function field(k: Key) {
    const id = `f-${k}`;
    const x = v[k];
    let input: React.ReactNode;
    if (OPTIONS[k]) input = <select id={id} name={k} value={String(x)} onChange={(e) => set(k, e.target.value)} className="input">{OPTIONS[k]!.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>;
    else if (typeof x === "boolean") input = <label className="flex h-10 items-center gap-2 text-sm"><input id={id} name={k} type="checkbox" checked={x} onChange={(e) => set(k, e.target.checked)} className="h-4 w-4" /> Yes</label>;
    else if (k === "eligibleEmploymentStatuses") input = (
      <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-sm">{EMPLOYMENT_STATUSES.map((s) => (
        <label key={s} className="flex items-center gap-1.5"><input type="checkbox" name={k} value={s} checked={(x as string[]).includes(s)}
          onChange={(e) => set(k, e.target.checked ? [...(x as string[]), s] : (x as string[]).filter((y) => y !== s))} />{s.replace("_", " ")}</label>
      ))}</div>
    );
    else input = <input id={id} name={k} value={String(x)} onChange={(e) => set(k, e.target.value)} inputMode={k === "requiredDocumentCodes" ? undefined : "decimal"} className="input" />;
    return (
      <div key={k} className={WIDE.includes(k) ? "sm:col-span-2 lg:col-span-3" : undefined}>
        <label htmlFor={id} className="label">{POLICY_FIELD_LABELS[k]}</label>
        {input}
        {HINTS[k] && <p className="hint">{HINTS[k]}</p>}
        {k === "requiredDocumentCodes" && <p className="hint">Codes separated by commas, for example PAYSLIP.</p>}
      </div>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Loan terms" description={description} className="xl:col-span-2">
        <ActionForm action={action} submitLabel="Save">
          <div className="space-y-7">
            {GROUPS.map((g) => (
              <fieldset key={g.title}>
                <legend className="mb-3 text-sm font-semibold text-navy">{g.title}</legend>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{g.fields.map(field)}</div>
              </fieldset>
            ))}
          </div>
        </ActionForm>
      </Card>

      <div className="space-y-6 xl:sticky xl:top-0 xl:self-start">
        <Card title="Check" actions={parsed.success ? <Badge tone="success">Valid</Badge> : <Badge tone="danger">{parsed.error.issues.length} to fix</Badge>}>
          {parsed.success ? <p className="text-sm text-muted">All values are consistent and ready to save.</p> : (
            <ul className="list-disc space-y-1 pl-4 text-sm text-danger">
              {parsed.error.issues.map((i, n) => <li key={n}>{POLICY_FIELD_LABELS[i.path[0] as Key] ?? String(i.path[0])}: {i.message.replace(/^Expected number, received nan$/i, "enter a number")}</li>)}
            </ul>
          )}
        </Card>

        {p && (
          <Card title="What staff will see" description={productName}>
            <ul className="space-y-1.5 text-sm text-slate-700">
              <li>Any amount their payslip allows, over a tenor of {p.minTenorMonths} to {monthsText(p.maxTenorMonths)}.</li>
              <li>{p.interestMethod === "interest_free" ? "Interest-free." : `${p.annualInterestRate}% a year, ${p.interestMethod === "flat" ? "flat rate" : "reducing balance"}.`}</li>
              <li>{`All monthly deductions, including this loan, are subject to a maximum of ${p.maxDeductionPercent}% of net pay.`}</li>
              <li>{p.requiredGuarantors ? `${p.requiredGuarantors} guarantor${p.requiredGuarantors > 1 ? "s" : ""} with ${p.guarantorMinServiceMonths}+ months' service.` : "No guarantors needed."}</li>
              <li>Tenors offered: {validTenors(p).length ? `${validTenors(p)[0]} to ${monthsText(validTenors(p).at(-1))}` : "none, check the tenor settings"}.</li>
            </ul>
          </Card>
        )}

        {p && (
          <Card title="Worked example" description="A confirmed member of staff with no other loans.">
            <div className="grid grid-cols-3 gap-2">
              {(["gross", "net", "amount"] as const).map((k) => (
                <div key={k}><label htmlFor={`ex-${k}`} className="text-xs font-medium text-slate-600">{k === "amount" ? "Amount" : `${k[0].toUpperCase()}${k.slice(1)} a month`}</label>
                  <input id={`ex-${k}`} value={example[k]} onChange={(e) => setExample({ ...example, [k]: e.target.value })} inputMode="decimal" className="input h-9 text-sm" /></div>
              ))}
            </div>
            {result ? (
              <dl className="mt-4 space-y-2 text-sm">
                <Row k="Most they can borrow" v={N(result.maxEligibleAmount)} strong />
                {result.quote && <>
                  <Row k="Tenor" v={`${monthsText(result.tenorMonths)}${result.tenorAutomatic ? " (shortest affordable)" : ""}`} />
                  <Row k="Instalment" v={N(result.quote.monthlyInstalment)} />
                  <Row k="Total interest" v={N(result.quote.totalInterest)} />
                  <Row k="Total to repay" v={N(result.quote.totalRepayable)} />
                  <Row k="Paid out" v={N(result.quote.principal)} />
                  <Row k="Take-home after" v={`${N(result.takeHomeAfter)} (${result.takeHomePercentAfter}% of gross)`} />
                </>}
                <div className={cx("mt-3 rounded-md px-3 py-2 text-sm", result.eligible ? "bg-green-50 text-success" : "bg-red-50 text-danger")}>
                  {result.eligible ? "Eligible on these figures." : result.reasons[0] ?? "Not eligible."}
                </div>
              </dl>
            ) : <p className="mt-3 text-sm text-muted">Enter pay figures to see the example.</p>}
          </Card>
        )}
        {!p && <Alert tone="warning">Fix the items above to see the preview.</Alert>}
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className={cx("tabular text-right", strong ? "font-semibold text-navy" : "font-medium text-ink")}>{v}</dd></div>;
}

