import { D, dec, formatNaira, m } from "@/lib/finance/money";
import type { PayslipAssessment } from "@/lib/finance/payslip";
import { cx } from "./ui";

const N = (v: string | null | undefined) => formatNaira(v);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-03" as "March 2026". */
export function payslipMonth(period: string | null | undefined) {
  if (!period) return "Payslip";
  const [y, mo] = period.split("-").map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

type Row = { label: React.ReactNode; amount: string; tone?: "total" | "key" | "less"; note?: string };

/**
 * The deduction limit worked out line by line from the payslip: net pay, 33.3% of it, the deductions
 * already taken, and what is left for a loan's monthly repayment.
 */
export function PayslipBreakdown({ a, period, guarantees, instalment, who = "your" }: {
  a: PayslipAssessment; period?: string | null;
  /** Monthly share of loans the person guarantees, when counted. */
  guarantees?: string;
  /** A loan's monthly repayment, to show what would be left. */
  instalment?: string | null;
  who?: "your" | "the applicant's" | "the guarantor's";
}) {
  const guaranteed = guarantees && dec(guarantees).greaterThan(0) ? guarantees : null;
  const available = guaranteed ? m(D.max(0, dec(a.room).minus(guaranteed))) : a.room;
  const rows: Row[] = [
    { label: "Basic salary", amount: a.basic },
    { label: "Medical allowance", amount: a.medical },
    { label: "Basic + medical", amount: a.payForLending, tone: "total" },
    { label: "tax (PAYE)", amount: a.tax, tone: "less" },
    { label: "pension", amount: a.pension, tone: "less" },
    { label: "NHF", amount: a.nhf, tone: "less", note: dec(a.nhf).greaterThan(0) ? undefined : "Not deducted" },
    { label: "Net pay", amount: a.netPay, tone: "key" },
    { label: `Deduction limit (${a.capPercent}% of net pay)`, amount: a.limit, tone: "total" },
    ...a.commitments.map((c): Row => ({
      label: c.label, amount: c.counted, tone: "less",
      note: c.kind === "cafeteria" ? `${N(c.shown)} used; ${N(c.counted)} is counted` : undefined,
    })),
    ...(guaranteed ? [{ label: "your share of loans you guarantee", amount: guaranteed, tone: "less" } as Row] : []),
    { label: "Maximum monthly instalment", amount: available, tone: "key", note: "Principal + interest" },
    ...(instalment ? [
      { label: "this loan's monthly instalment", amount: instalment, tone: "less" } as Row,
      { label: "Remaining after this loan", amount: m(dec(available).minus(instalment)), tone: "total" } as Row,
    ] : []),
  ];
  return (
    <div>
      <p className="mb-2 text-xs text-muted">From {who} {payslipMonth(period)} payslip.</p>
      <table className="w-full text-sm">
        <caption className="sr-only">Deduction limit worked out from the payslip</caption>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className={cx(r.tone === "key" ? "bg-brand-50 font-semibold text-navy" : r.tone === "total" ? "font-medium text-ink" : "font-normal text-slate-700")}>
              <th scope="row" className="py-2 pl-3 pr-4 text-left" style={{ fontWeight: "inherit" }}>
                {r.tone === "less" ? <span className="text-muted">Less </span> : null}{r.label}
                {r.note && <span className="block text-xs font-normal text-muted">{r.note}</span>}
              </th>
              <td className="tabular whitespace-nowrap py-2 pr-3 text-right">{r.tone === "less" && dec(r.amount).greaterThan(0) ? "−" : ""}{N(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {a.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warning">{w}</p>)}
    </div>
  );
}
