"use server";

import { getDb } from "@/db";
import { runAction, str, money, file, int } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { validateUpload } from "@/server/services/documents";
import { confirmEarlyRepayment, declineEarlyRepayment, requestEarlyRepayment } from "@/server/services/loans";
import { setFundPool } from "@/server/services/funds";

type Prev = ActionResult | null;

/** Borrower: the whole balance has been paid by transfer; send the receipt. */
export async function requestEarlyRepaymentAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const f = file(fd, "receipt");
    const ev = f ? await validateUpload(db, f) : null;
    await requestEarlyRepayment(db, actor, loanId, { payerReference: str(fd, "payerReference"), receipt: ev ? { buffer: ev.buffer, fileName: ev.fileName, mimeType: ev.mime } : null });
    return { message: "Sent. The Payroll Manager will check the payment and mark your loan repaid.", redirectTo: `/loans/${loanId}` };
  }, { revalidate: [`/loans/${loanId}`], limit: 10 });
}

/** Payroll Manager: mark the loan repaid in full, with a fresh two-step verification code. */
export async function confirmEarlyRepaymentAction(id: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await confirmEarlyRepayment(await getDb(), actor, id, { code: str(fd, "code", true) });
    return "Confirmed. The loan is repaid in full and closed.";
  }, { revalidate: ["/payroll"], limit: 10 });
}

export async function declineEarlyRepaymentAction(id: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await declineEarlyRepayment(await getDb(), actor, id, str(fd, "reason"));
    return "Declined. The borrower has been told why.";
  }, { revalidate: ["/payroll"] });
}

/** Head of Account: the fund pool for a year. */
export async function setFundPoolAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const year = int(fd, "year", "Year");
    await setFundPool(await getDb(), actor, { year, amount: money(fd, "amount", "the pool amount"), note: str(fd, "note") });
    return `The fund pool for ${year} is saved. Bursary staff can see it now.`;
  }, { revalidate: ["/finance", "/dashboard", "/accounts"] });
}
