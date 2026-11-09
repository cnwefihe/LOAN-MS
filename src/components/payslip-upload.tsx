"use client";

import { useEffect, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { uploadPayslipAction } from "@/app/actions/applicant";
import { ActionForm } from "./action-form";
import { payslipMonth } from "./payslip-breakdown";

/**
 * Upload the latest payslip (PDF from SeamlessHR). Each visit starts with an empty upload box;
 * `current` is only the payslip uploaded on this visit. `previous` names an earlier one that will
 * be used if nothing new is uploaded (applications only).
 */
export function PayslipUpload({ current, previous }: { current: { id: string; period: string | null; uploadedOn: string } | null; previous?: string | null }) {
  const [another, setAnother] = useState(false);
  // Comes back to this page, with the new payslip marked as uploaded on this visit.
  const [returnTo, setReturnTo] = useState("");
  useEffect(() => setReturnTo(window.location.pathname + window.location.search), []);
  useEffect(() => setAnother(false), [current?.id]);
  return (
    <div>
      {current && !another ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
          <p className="flex items-center gap-2 text-sm"><FileCheck2 aria-hidden className="h-4 w-4 shrink-0 text-success" /><span><b className="block font-medium text-ink">{current.period ? payslipMonth(current.period) : "Payslip"} payslip</b><span className="text-xs text-muted">Uploaded {current.uploadedOn}</span></span></p>
          <button type="button" className="link text-sm" onClick={() => setAnother(true)}>Upload another</button>
        </div>
      ) : (
        <ActionForm action={uploadPayslipAction} submitLabel="Read payslip" encType="multipart/form-data">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label htmlFor="payslip" className="label">Your latest payslip (PDF)</label>
          <input id="payslip" name="payslip" type="file" accept="application/pdf,.pdf" required className="input" />
          <p className="hint">
            The PDF from SeamlessHR. Its name, employee code and pay grade must match the payslip details on <a className="link" href="/profile">My profile</a>.
            {previous && <> If you do not upload one, your {previous} payslip is used.</>}
          </p>
        </ActionForm>
      )}
    </div>
  );
}
