"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleAlert, CircleX } from "lucide-react";
import { PERIOD_MONTHS, quoteLoan, validTenors } from "@/lib/finance/calculator";
import { assessForStaff, NO_PAYSLIP_REASON, type StaffContext, type StaffEligibility } from "@/lib/finance/staff-eligibility";
import { dec, formatNaira, parseMoneyInput } from "@/lib/finance/money";
import { ADVANCE_TYPES, type AdvanceType, type PolicyParameters } from "@/lib/finance/policy";
import { PayslipBreakdown } from "./payslip-breakdown";
import { PayslipUpload } from "./payslip-upload";
import { Card, Field, Table, Th, Td, cx } from "@/components/ui";
import { monthsText } from "@/lib/finance/dates";

export interface CalculatorProduct { id: string; name: string; params: PolicyParameters }
export interface CalculatorGuarantee { reference: string; applicantName: string; currentExposure: string; monthlyCommitment: string; monthsLeft: number; disbursed: boolean }

const N = (v: string | null | undefined) => formatNaira(v);

function money(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  try { return parseMoneyInput(raw); } catch { return undefined; }
}

/** Reasons that stop someone applying at all (as opposed to asking for more than their pay allows). */
const blockersOf = (r: StaffEligibility) => r.reasons.filter((x) => !x.startsWith("The amount you asked for") && x !== NO_PAYSLIP_REASON);

/**
 * Eligibility calculator. The applicant uploads their latest payslip; what they can borrow is worked out
 * from it with the same rules the application uses. They may then enter an amount and a tenor.
 */
export function EligibilityCalculator({ products, ctx, standing, payslipOnFile, guarantees, asOf, initial }: {
  products: CalculatorProduct[];
  ctx: StaffContext;
  /** Their record with the payslip already on file: only used to say straight away when they cannot apply at all. */
  standing?: StaffContext;
  payslipOnFile: { id: string; period: string | null; uploadedOn: string } | null;
  guarantees: CalculatorGuarantee[];
  asOf: string;
  initial: { productId?: string; amount?: string; tenor?: string };
}) {
  const [productId, setProductId] = useState(products.find((p) => p.id === initial.productId)?.id ?? products[0].id);
  const [amount, setAmount] = useState(initial.amount ?? "");
  const [advanceType, setAdvanceType] = useState<AdvanceType>("salary");
  const product = products.find((p) => p.id === productId)!;
  const p = product.params;
  const isAdvance = p.productType === "advance";
  const tenors = validTenors(p);
  const [tenor, setTenor] = useState(initial.tenor && tenors.includes(Number(initial.tenor)) ? initial.tenor : String(tenors.at(-1) ?? p.maxTenorMonths));
  const months = tenors.includes(Number(tenor)) ? Number(tenor) : tenors.at(-1) ?? p.maxTenorMonths;
  const requested = money(amount);

  const result = useMemo(() => ctx.payslip ? assessForStaff(p, ctx, {
    requestedAmount: requested, tenorMonths: isAdvance ? 1 : months, asOf, advanceType: isAdvance ? advanceType : null,
  }) : null, [p, ctx, requested, months, asOf, isAdvance, advanceType]);
  // Before a payslip is uploaded on this visit, someone who cannot apply at all (for example, because a loan is still open) is told at once.
  const blocked = useMemo(() => {
    if (ctx.payslip || !standing?.payslip) return null;
    // No date: this looks only for what stops them applying at all (such as an open loan), not at the payslip's month.
    const r = assessForStaff(p, standing, { requestedAmount: undefined, tenorMonths: isAdvance ? 1 : months, asOf: undefined, advanceType: isAdvance ? advanceType : null });
    return blockersOf(r).length ? r : null;
  }, [p, ctx.payslip, standing, months, asOf, isAdvance, advanceType]);
  const shown = result ?? blocked;

  const step = (n: number, done: boolean) => (
    <span aria-hidden className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold", done ? "bg-navy text-white" : "bg-brand-100 text-navy")}>{n}</span>
  );

  const answer = isAdvance
    ? <AdvanceAnswer r={shown} productId={productId} onUseMax={(v) => setAmount(Number(v).toLocaleString("en-GB"))} />
    : <Answer r={shown} p={p} months={months} productId={productId} onUseMax={(v) => setAmount(Number(v).toLocaleString("en-GB"))} />;
  // Loans always show the result under the details, with the working on the right. Advances have no working to show.
  const breakdown = !isAdvance;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="flex flex-col gap-6 lg:col-span-2">
        <Card title="Your details" description="Upload your payslip; the result updates as you go.">
          <ol className="space-y-6">
            <li className="flex gap-3">
              {step(1, !!ctx.payslip)}
              <div className="min-w-0 flex-1"><PayslipUpload current={payslipOnFile} /></div>
            </li>
            {products.length > 1 && (
              <li className="flex gap-3">
                {step(2, true)}
                <div className="flex-1">
                  <Field label="Product" htmlFor="productId">
                    <select id="productId" value={productId} onChange={(e) => setProductId(e.target.value)} className="input">
                      {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </Field>
                  {isAdvance && (
                    <div className="mt-3">
                      <Field label="Advance against" htmlFor="advanceType">
                        <select id="advanceType" value={advanceType} onChange={(e) => setAdvanceType(e.target.value as AdvanceType)} className="input">
                          {Object.entries(ADVANCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </Field>
                      <p className="hint">{advanceType === "salary" ? "A part payment from your net pay." : "A part payment from one month's basic salary."}</p>
                    </div>
                  )}
                </div>
              </li>
            )}
            <li className="flex gap-3">
              {step(products.length > 1 ? 3 : 2, !!requested)}
              <div className="flex-1">
                <Field label={isAdvance ? "How much would you like in advance? (₦)" : "How much would you like to borrow? (₦)"} htmlFor="amount"
                  hint="Optional. Leave blank to see the most you may have.">
                  <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
                </Field>
                {amount.trim() && !requested && <p className="mt-1 text-xs text-danger">Enter a number, for example 500,000.</p>}
              </div>
            </li>
            {!isAdvance && (
              <li className="flex gap-3">
                {step(products.length > 1 ? 4 : 3, true)}
                <div className="flex-1">
                  <Field label="Tenor" htmlFor="tenor" hint="Twelve months at most.">
                    <select id="tenor" value={String(months)} onChange={(e) => setTenor(e.target.value)} className="input">
                      {tenors.map((t) => <option key={t} value={t}>{monthsText(t)}</option>)}
                    </select>
                  </Field>
                </div>
              </li>
            )}
          </ol>
        </Card>
        {/* The result sits here and fills the column to the same height as the card beside it. */}
        {breakdown && <div className="flex-1 [&>*]:h-full">{answer}</div>}
        </div>

        <div className="flex flex-col gap-6 lg:col-span-3">
          {!breakdown && answer}
          {result?.payslip && !isAdvance && (
            <Card className="flex-1" title="How this is calculated" description={`All deductions, including this loan, within ${p.maxDeductionPercent}% of net pay.`}>
              <PayslipBreakdown a={result.payslip} period={ctx.payslip?.period} guarantees={result.guaranteeCommitment} instalment={result.shortfall ? null : result.instalmentMonthly} />
              <MaxLoan r={result} p={p} months={months} />
            </Card>
          )}
          {!result?.payslip && !isAdvance && (
            <Card className="flex-1" title="How this is calculated" bodyClassName="flex min-h-40 items-center justify-center text-center">
              <p className="max-w-xs text-sm text-muted">Your figures will appear here once your payslip is uploaded.</p>
            </Card>
          )}
        </div>
      </div>

      {result && guarantees.length > 0 && <Guarantees items={guarantees} r={result} />}
      {shown && <IneligibleDialog reasons={blockersOf(shown)} />}
    </div>
  );
}

/** Pops up the reasons someone cannot apply, so they are not left wondering why. */
function IneligibleDialog({ reasons }: { reasons: string[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const key = reasons.join("|");
  useEffect(() => {
    if (key && !ref.current?.open) ref.current?.showModal?.();
  }, [key]);
  if (!reasons.length) return null;
  return (
    <dialog ref={ref} aria-labelledby="ineligible-title" className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="p-5">
        <div className="flex gap-3">
          <CircleX aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-danger" />
          <div>
            <h2 id="ineligible-title" className="text-lg font-semibold text-ink">You are not eligible at present</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        </div>
        <form method="dialog" className="mt-5 flex justify-end"><button className="btn-secondary">Close</button></form>
      </div>
    </dialog>
  );
}

/** The amount entered (or, with none or too much, the maximum loan), with the formula filled in. */
function MaxLoan({ r, p, months }: { r: StaffEligibility; p: PolicyParameters; months: number }) {
  if (dec(r.maxEligibleAmount).lessThanOrEqualTo(0)) return null;
  // The amount entered when it is within the limit; otherwise the largest loan whose monthly repayment, with its interest, fits.
  const own = r.quote && !r.shortfall;
  const q = own ? r.quote! : quoteLoan(r.maxEligibleAmount, months, p.interestMethod, p.annualInterestRate, null, PERIOD_MONTHS[p.repaymentFrequency]);
  const interest = p.interestMethod === "interest_free" ? "Interest (none)" : `Interest (${p.annualInterestRate}%)`;
  const rows: [string, string, boolean?][] = [
    ["Principal (amount disbursed)", q.principal],
    [interest, q.totalInterest],
    ["Monthly instalment", q.monthlyInstalment, true],
    ["Total repayment (principal + interest)", q.totalRepayable, true],
  ];
  return (
    <div className="mt-4 rounded-md border border-line bg-slate-50 px-3 py-3 text-sm">
      <p className="font-medium text-ink">{own ? "Your loan" : "Maximum loan"} (tenor: {monthsText(months)})</p>
      <dl className="mt-2 divide-y divide-line">
        {rows.map(([k, v, bold]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className={bold ? "font-medium text-ink" : "text-slate-700"}>{k}</dt>
            <dd className={cx("tabular", bold ? "font-semibold text-ink" : "text-slate-700")}>{N(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The single answer: can apply (and for how much), asked for too much, or cannot apply yet. */
function Answer({ r, p, months, productId, onUseMax }: {
  r: StaffEligibility | null; p: PolicyParameters; months: number; productId: string; onUseMax: (v: string) => void;
}) {
  if (!r) {
    return (
      <Card title="Your result" bodyClassName="flex min-h-40 items-center justify-center text-center">
        <p className="max-w-xs text-sm text-muted">Begin by uploading your latest payslip.</p>
      </Card>
    );
  }
  const blockers = blockersOf(r);
  const q = r.quote;
  const max = r.maxEligibleAmount;

  if (blockers.length) {
    return (
      <Card title="Your result">
        <div className="flex gap-3">
          <CircleX aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-danger" />
          <div>
            <p className="text-lg font-semibold text-ink">You cannot apply at present</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{blockers.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        </div>
      </Card>
    );
  }

  const tooMuch = !!r.shortfall;
  return (
    <Card title="Your result">
      {tooMuch ? (
        <div className="flex gap-3">
          <CircleAlert aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
          <div>
            <p className="text-lg font-semibold text-ink">{N(r.requestedAmount)} is more than your pay allows</p>
            <p className="mt-1 text-sm text-slate-700">Over {monthsText(months)}, the most you may borrow is <b className="text-ink">{N(max)}</b>.{r.suggestedTenorMonths && r.suggestedTenorMonths > months ? ` Or choose ${monthsText(r.suggestedTenorMonths)} to repay ${N(r.requestedAmount)}.` : ""}</p>
            <button type="button" className="btn-secondary mt-3" onClick={() => onUseMax(max)}>Use {N(max)}</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-3">
          <CircleCheck aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-success" />
          <div>
            {q
              ? <p className="text-lg font-semibold text-ink">You may apply for {N(q.principal)}</p>
              : <p className="text-lg font-semibold text-ink">You may borrow up to {N(max)}</p>}
            <p className="mt-1 text-sm text-slate-700">{q ? `The most you may borrow over ${monthsText(months)} is ${N(max)}.` : `Repaid over ${monthsText(months)}. Enter an amount to see the repayments.`}</p>
          </div>
        </div>
      )}

      {q && !tooMuch && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-3 2xl:grid-cols-4">
            <Fig label="Principal" value={N(q.principal)} strong />
            <Fig label="Interest" value={N(q.totalInterest)} note={p.interestMethod === "interest_free" ? "Interest-free" : `${p.annualInterestRate}%`} />
            <Fig label="Monthly instalment" value={N(r.instalmentMonthly)} note={`Tenor: ${monthsText(months)}`} strong />
            <Fig label="Total repayment" value={N(q.totalRepayable)} note="Principal + interest" />
          </dl>
          <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-success">
            Total deductions with this loan: {r.totalDeductionPercentAfter}% of net pay (limit {p.maxDeductionPercent}%).
          </p>
          <div className="mt-3 flex justify-end">
            <Link className="btn-primary" href={`/applications/new?productId=${productId}&amount=${q.principal}&tenor=${months}`}>Apply for {N(q.principal)}</Link>
          </div>
        </>
      )}
    </Card>
  );
}

/** For an advance: what the payment comes to, the most that can be advanced, and what is still paid later. */
function AdvanceAnswer({ r, productId, onUseMax }: { r: StaffEligibility | null; productId: string; onUseMax: (v: string) => void }) {
  if (!r || !r.advance) {
    return (
      <Card title="Your result" bodyClassName="flex min-h-40 items-center justify-center text-center">
        <p className="max-w-xs text-sm text-muted">Begin by uploading your latest payslip.</p>
      </Card>
    );
  }
  const a = r.advance;
  const label = ADVANCE_TYPES[a.type].toLowerCase();
  const blockers = blockersOf(r);
  const q = r.quote;
  return (
    <Card title="Your result">
      <dl className="grid grid-cols-2 gap-4">
        <Fig label={`Your ${label}`} value={N(a.payment)} note={a.type === "salary" ? "Net pay on your payslip" : "One month's basic salary"} />
        <Fig label="Most that can be advanced" value={N(r.maxEligibleAmount)} strong />
      </dl>
      <div className="mt-5 border-t border-line pt-4">
        {blockers.length ? (
          <div className="flex gap-3"><CircleX aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-danger" />
            <div><p className="text-lg font-semibold text-ink">An advance is not available at the moment</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">{blockers.map((x) => <li key={x}>{x}</li>)}</ul></div></div>
        ) : r.shortfall ? (
          <div className="flex gap-3"><CircleAlert aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-warning" />
            <div><p className="text-lg font-semibold text-ink">{N(r.requestedAmount)} is more than can be advanced</p>
              <button type="button" className="btn-secondary mt-3" onClick={() => onUseMax(r.maxEligibleAmount)}>Use {N(r.maxEligibleAmount)}</button></div></div>
        ) : q ? (
          <>
            <div className="flex gap-3"><CircleCheck aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-success" />
              <p className="text-lg font-semibold text-ink">You may request {N(q.principal)} in advance</p></div>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <Fig label="Amount disbursed on approval" value={N(q.principal)} strong />
              <Fig label={`Still paid with your ${label}`} value={N(a.remaining)} strong />
            </dl>
            <p className="mt-3 text-sm text-muted">Interest-free; deducted from your {label}.</p>
            <div className="mt-5 flex justify-end">
              <Link className="btn-primary" href={`/applications/new?productId=${productId}&amount=${q.principal}&advanceType=${a.type}`}>Request {N(q.principal)}</Link>
            </div>
          </>
        ) : <p className="text-sm text-muted">Enter the amount you would like in advance.</p>}
      </div>
    </Card>
  );
}

function Fig({ label, value, note, strong }: { label: string; value: React.ReactNode; note?: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx("tabular mt-0.5", strong ? "text-lg font-semibold text-navy" : "text-sm font-medium text-ink")}>{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

function Guarantees({ items, r }: { items: CalculatorGuarantee[]; r: StaffEligibility }) {
  const counted = dec(r.guaranteeCommitment).greaterThan(0);
  return (
    <Card title="Loans you guarantee" description={counted ? "Your share of these loans is set aside from your limit each month." : "Shown for information. They are not counted against your limit."}>
      <Table caption="Loans you guarantee">
        <thead><tr><Th>Borrower</Th><Th>Reference</Th><Th right>Your share outstanding</Th><Th right>Months left</Th><Th right>Set aside a month</Th></tr></thead>
        <tbody>{items.map((g) => (
          <tr key={g.reference}><Td>{g.applicantName}</Td><Td>{g.reference}{!g.disbursed && <span className="text-xs text-muted"> (not yet paid out)</span>}</Td><Td right>{N(g.currentExposure)}</Td><Td right>{g.monthsLeft}</Td><Td right>{N(g.monthlyCommitment)}</Td></tr>
        ))}</tbody>
      </Table>
    </Card>
  );
}
