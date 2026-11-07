/** "pending_disbursement" becomes "Pending disbursement". */
export function humanise(v: unknown): string {
  const s = String(v ?? "").replace(/_/g, " ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
