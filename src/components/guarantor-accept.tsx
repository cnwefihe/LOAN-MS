"use client";

import { CircleCheck, CircleX } from "lucide-react";
import { ActionForm } from "./action-form";
import { Alert } from "./ui";
import { formatNaira } from "@/lib/finance/money";
import type { Payslip } from "@/lib/finance/payslip";
import { guarantorCover } from "@/lib/finance/staff-eligibility";
import { todayLagos } from "@/lib/finance/dates";
import type { PolicyParameters } from "@/lib/finance/policy";
import type { ActionResult } from "@/server/action-result";
import { PayslipBreakdown } from "./payslip-breakdown";
import { PayslipUpload } from "./payslip-upload";

const N = (v: string) => formatNaira(v);

/**
 * The guarantor first uploads their latest payslip. If, on that payslip, they could take over their share
 * of the repayments should the borrower stop paying (within the guarantor deduction limit of their net pay),
 * the acceptance form is shown; otherwise it is not, and they may decline.
 */
export function GuarantorAccept({ action, policy, cover, payslipOnFile, applicantName, guaranteedAmount, termsVersion, relationships, phone, name, details }: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  policy: PolicyParameters;
  cover: { payslip: Payslip | null; otherGuarantees: string; monthlyShare: string; monthsLeft: number };
  payslipOnFile: { id: string; period: string | null; uploadedOn: string } | null;
  applicantName: string;
  guaranteedAmount: string;
  termsVersion: number;
  relationships: readonly string[];
  phone: string;
  name: string;
  details: string;
}) {
  const check = cover.payslip ? guarantorCover(policy, { payslip: cover.payslip, otherGuarantees: cover.otherGuarantees, monthlyShare: cover.monthlyShare, asOf: todayLagos() }) : null;

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-line p-4">
        <h4 className="text-sm font-semibold text-ink">Step 1: confirm that you could cover your share</h4>
        <p className="mt-1 text-sm text-muted">
          If {applicantName} stops paying, you may have to repay about {N(cover.monthlyShare)} a month. Upload your latest payslip to check.
        </p>
        <div className="mt-3 max-w-lg"><PayslipUpload current={payslipOnFile} /></div>
        {check && (
          <div className="mt-4 max-w-xl">
            <PayslipBreakdown a={check.payslip} period={cover.payslip?.period} guarantees={check.otherGuarantees} instalment={check.monthlyShare} who="your" />
          </div>
        )}
        {check && (check.ok
          ? <p className="mt-4 flex items-center gap-2 text-sm font-medium text-success"><CircleCheck aria-hidden className="h-5 w-5" /> You could cover {N(check.monthlyShare)} a month. You may accept below.</p>
          : <div className="mt-4"><Alert tone="danger" title="You could not cover this guarantee">
              <span className="inline-flex items-start gap-2"><CircleX aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />{check.payslip.problems.length ? check.payslip.problems.join(" ") : `Only ${N(check.available)} a month is available within the ${check.payslip.capPercent}% limit, which is less than your share of ${N(check.monthlyShare)}. You may decline the request below.`}</span>
            </Alert></div>)}
      </div>

      {check?.ok && (
        <div className="rounded-md border border-green-200 p-4">
          <h4 className="text-sm font-semibold text-success">Step 2: accept and sign</h4>
          <ActionForm action={action} submitLabel="Accept and sign electronically" variant="success" confirm="Accept this guarantee? This is a binding commitment.">
            <input type="hidden" name="decision" value="accept" />
            <fieldset className="mt-2 space-y-2 text-sm">
              <legend className="sr-only">Confirmations</legend>
              <label className="flex gap-2"><input type="checkbox" name="c1" required className="mt-1" /> I have read the guarantor agreement (version {termsVersion}) above.</label>
              <label className="flex gap-2"><input type="checkbox" name="c2" required className="mt-1" /> I understand that I may be liable for up to {N(guaranteedAmount)} if the borrower defaults.</label>
              <label className="flex gap-2"><input type="checkbox" name="c3" required className="mt-1" /> The information I have given is accurate and complete, and the University may contact me directly if the applicant defaults.</label>
            </fieldset>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><label htmlFor="relationship" className="label">Relationship with the applicant</label>
                <select id="relationship" name="relationship" required defaultValue="" className="input"><option value="" disabled>Select</option>{relationships.map((r) => <option key={r}>{r}</option>)}</select></div>
              <div><label htmlFor="phone" className="label">Your telephone number(s)</label><input id="phone" name="phone" required defaultValue={phone} autoComplete="tel" className="input" /><p className="hint">Separate two numbers with a comma.</p></div>
            </div>
            <p className="mt-2 text-xs text-muted">{details}</p>
            <label htmlFor="typedName" className="label mt-3">Type your full name to sign: <span className="font-normal text-muted">{name}</span></label>
            <input id="typedName" name="typedName" required autoComplete="off" className="input max-w-sm" />
            <p className="hint">Your signature, the time and your IP address are recorded.</p>
          </ActionForm>
        </div>
      )}
    </div>
  );
}
