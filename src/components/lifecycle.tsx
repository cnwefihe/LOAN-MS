import { getDb } from "@/db";
import { departmentHeadOf } from "@/server/services/staff";
import { StageTracker } from "./ui";

/** Short step labels, so each fits on one line under its step. */
export const APP_STAGES = ["Submitted", "Guarantors", "Human Resources", "Bursary", "HOD", "HR Director", "Bursar", "Paid out", "Repaying", "Closed"];

/**
 * Map application + loan status onto the end-to-end lifecycle tracker. While awaiting approval,
 * level says which approval it is at: 1 Line Manager, 2 HR Director, 3 Bursar.
 */
export function lifecycleIndex(appStatus: string, loanStatus?: string | null, level = 1): { current: number; failed: boolean } {
  if (loanStatus) {
    if (loanStatus === "pending_disbursement") return { current: 7, failed: false };
    if (loanStatus === "closed") return { current: 10, failed: false };
    if (loanStatus === "written_off" || loanStatus === "cancelled") return { current: 8, failed: true };
    return { current: 8, failed: false };
  }
  switch (appStatus) {
    case "draft": return { current: 0, failed: false };
    case "returned": return { current: 0, failed: false };
    case "pending_guarantor": return { current: 1, failed: false };
    case "pending_hr": return { current: 2, failed: false };
    case "pending_bursary": return { current: 3, failed: false };
    case "pending_approval": return { current: 3 + Math.min(Math.max(level, 1), 3), failed: false };
    case "approved": return { current: 7, failed: false };
    // Declined before the approvals (level 0) stops at the HR or Bursary review.
    case "declined": return { current: level ? 3 + Math.min(level, 3) : 3, failed: true };
    case "cancelled": return { current: 0, failed: true };
    default: return { current: 0, failed: false };
  }
}

export async function LifecycleTracker({ appStatus, loanStatus, level, applicantId }: { appStatus: string; loanStatus?: string | null; level?: number; applicantId: string }) {
  const { current, failed } = lifecycleIndex(appStatus, loanStatus, level ?? 0);
  // The first approval is the department's HOD or, for a unit, its Line Manager.
  const title = (await departmentHeadOf(await getDb(), applicantId))?.approverTitle;
  const stages = [...APP_STAGES];
  if (title === "line_manager") stages[4] = "Line Manager";
  return <StageTracker stages={stages} current={current} failed={failed} />;
}
