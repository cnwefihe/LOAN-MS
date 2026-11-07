import { payslipDetailsConfirmed } from "@/server/services/staff";
import { confirmPayslipDetailsAction } from "@/app/actions/staff-ops";
import type { staffProfiles } from "@/db/schema";
import { ActionForm } from "./action-form";
import { Badge, DateText, KeyValues } from "./ui";

type Profile = typeof staffProfiles.$inferSelect | null;

export function payslipDetailsBadge(p: Profile) {
  if (!p?.staffNumber || !p.payGrade) return <Badge tone="warning">Not entered</Badge>;
  return payslipDetailsConfirmed(p) ? <Badge tone="success">Confirmed by Human Resources</Badge> : <Badge tone="warning">Awaiting Human Resources confirmation</Badge>;
}

/** The name, employee code and pay grade a staff member entered from their payslip, with HR's confirm button. */
export function PayslipDetails({ userId, displayName, profile: p, canConfirm, back, who }: { userId: string; displayName: string; profile: Profile; canConfirm: boolean; back: string; who?: string }) {
  const pending = !!p?.staffNumber && !!p.payGrade && !payslipDetailsConfirmed(p);
  return (
    <div>
      {who && <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium text-ink">{who} {payslipDetailsBadge(p)}</p>}
      <KeyValues columns={3} items={[["Name", p?.payslipName || displayName], ["Employee code", p?.staffNumber ?? "Not entered"], ["Pay grade", p?.payGrade ?? "Not entered"]]} />
      {p?.payslipDetailsUpdatedAt && <p className="mt-2 text-xs text-muted">Last changed by the staff member <DateText value={p.payslipDetailsUpdatedAt} withTime />{payslipDetailsConfirmed(p) && p.payslipDetailsConfirmedAt && <>; confirmed <DateText value={p.payslipDetailsConfirmedAt} withTime /></>}.</p>}
      {pending && canConfirm && (
        <ActionForm action={confirmPayslipDetailsAction.bind(null, userId, back)} submitLabel="Confirm details" variant="secondary"
          confirm={`Confirm that these details match ${displayName}'s personnel record?`} />
      )}
    </div>
  );
}
