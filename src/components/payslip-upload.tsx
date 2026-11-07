"use client";

import { useEffect, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { uploadPayslipAction } from "@/app/actions/applicant";
import { ActionForm } from "./action-form";
import { payslipMonth } from "./payslip-breakdown";

/** Upload the latest payslip (PDF from SeamlessHR); shows the one on file and lets it be replaced. */
export function PayslipUpload({ current }: { current: { id: string; period: string | null; uploadedOn: string } | null }) {
  const [replacing, setReplacing] = useState(!current);
  // A newly read payslip replaces the form with its summary.
  useEffect(() => setReplacing(!current), [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {current && !replacing ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
          <p className="flex items-center gap-2 text-sm"><FileCheck2 aria-hidden className="h-4 w-4 shrink-0 text-success" /><span><b className="block font-medium text-ink">{payslipMonth(current.period)} payslip</b><span className="text-xs text-muted">Uploaded {current.uploadedOn}</span></span></p>
          <button type="button" className="link text-sm" onClick={() => setReplacing(true)}>Replace</button>
        </div>
      ) : (
        <ActionForm action={uploadPayslipAction} submitLabel="Read payslip" encType="multipart/form-data" variant={current ? "secondary" : "primary"}>
          <label htmlFor="payslip" className="label">Your latest payslip (PDF)</label>
          <input id="payslip" name="payslip" type="file" accept="application/pdf,.pdf" required className="input" />
          <p className="hint">The PDF from SeamlessHR. Its name, employee code and pay grade must match the payslip details on <a className="link" href="/profile">My profile</a>.</p>
        </ActionForm>
      )}
    </div>
  );
}
