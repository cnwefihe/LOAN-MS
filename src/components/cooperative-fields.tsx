"use client";

import { useState } from "react";
import { Field } from "./ui";

/**
 * "Do you owe the cooperative?" on the application form. A cooperative loan is deducted from pay
 * too, so its monthly deduction counts against take-home pay when eligibility is worked out.
 */
export function CooperativeFields({ initial }: { initial: { answer?: "yes" | "no"; monthly?: string; balance?: string } }) {
  const [answer, setAnswer] = useState(initial.answer ?? "");
  return (
    <div className="mt-3 space-y-3">
      <fieldset>
        <legend className="label">Do you have an existing cooperative loan?</legend>
        <div className="flex gap-5 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="hasCooperativeLoan" value="no" required checked={answer === "no"} onChange={() => setAnswer("no")} /> No</label>
          <label className="flex items-center gap-2"><input type="radio" name="hasCooperativeLoan" value="yes" checked={answer === "yes"} onChange={() => setAnswer("yes")} /> Yes</label>
        </div>
      </fieldset>
      {answer === "yes" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly cooperative deduction (₦)" htmlFor="cooperativeMonthly" hint="As shown on your payslip.">
            <input id="cooperativeMonthly" name="cooperativeMonthly" inputMode="decimal" required defaultValue={initial.monthly} className="input" />
          </Field>
          <Field label="Outstanding balance (₦)" htmlFor="cooperativeBalance" hint="Optional.">
            <input id="cooperativeBalance" name="cooperativeBalance" inputMode="decimal" defaultValue={initial.balance} className="input" />
          </Field>
        </div>
      )}
    </div>
  );
}
