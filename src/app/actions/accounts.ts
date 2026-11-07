"use server";

import { getDb } from "@/db";
import { runAction, str, money, file, dateStr, bool } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { assertCan } from "@/server/actor";
import { DomainError } from "@/server/errors";
import {
  recordDisbursement, confirmRepaymentClaim, rejectRepaymentClaim, recordRepayment,
  proposeWaiver, proposeRefund, approvePendingTransaction, rejectPendingTransaction, decideRestructure, runServicing,
  callOnGuarantors, proposeWriteOff, realignSchedule,
} from "@/server/services/loans";
import { proposeReversal } from "@/server/services/ledger";
import { validateUpload } from "@/server/services/documents";
import { processOutbox } from "@/server/email";
import { parseDeductionCsv, payrollProvider } from "@/server/integrations/payroll";
import { postPayrollDeductions, syncPayrollMonth } from "@/server/services/payroll";

type Prev = ActionResult | null;
const PAYMENT_METHODS = ["bank_transfer", "cheque", "internal_transfer", "payroll"] as const;

export async function recordDisbursementAction(loanId: string, idempotencyKey: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const method = str(fd, "paymentMethod") as (typeof PAYMENT_METHODS)[number];
    if (!PAYMENT_METHODS.includes(method)) throw new DomainError("Choose a payment method.");
    const f = file(fd, "evidence");
    const ev = f ? await validateUpload(db, f) : null;
    const d = await recordDisbursement(db, actor, loanId, {
      paymentDate: dateStr(fd, "paymentDate", "payment date"), paymentMethod: method, transactionReference: str(fd, "transactionReference", true),
      amountDisbursed: money(fd, "amountDisbursed", "the amount disbursed"), notes: str(fd, "notes"), idempotencyKey,
      evidence: ev ? { buffer: ev.buffer, fileName: ev.fileName, mimeType: ev.mime } : null,
    });
    return d ? "Payment recorded. The loan is now active and the repayment schedule has started." : "Payment recorded.";
  }, { revalidate: ["/accounts"] });
}

export async function confirmClaimAction(claimId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await confirmRepaymentClaim(await getDb(), actor, claimId, { amount: money(fd, "amount", "the confirmed amount"), valueDate: dateStr(fd, "valueDate", "value date"), bankReference: str(fd, "bankReference"), comment: str(fd, "comment") });
    return t.status === "posted" ? "Repayment confirmed and posted to the ledger." : "Confirmation recorded; awaiting checker approval.";
  }, { revalidate: ["/accounts"] });
}

export async function rejectClaimAction(claimId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await rejectRepaymentClaim(await getDb(), actor, claimId, str(fd, "reason"));
    return "Claim rejected and the staff member notified.";
  }, { revalidate: ["/accounts"] });
}

export async function callGuarantorsAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const n = await callOnGuarantors(await getDb(), actor, loanId, str(fd, "comment"));
    return `${n} guarantor(s) formally notified of their obligation.`;
  }, { revalidate: ["/accounts"] });
}

export async function writeOffAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await proposeWriteOff(await getDb(), actor, loanId, str(fd, "reason"));
    return t.status === "posted" ? "Balance written off." : "Write-off proposed; awaiting checker approval.";
  }, { revalidate: ["/accounts"] });
}

export async function recordRepaymentAction(loanId: string, idempotencyKey: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await recordRepayment(await getDb(), actor, loanId, { amount: money(fd, "amount", "the amount"), valueDate: dateStr(fd, "valueDate", "value date"), reference: str(fd, "reference", true), channel: str(fd, "channel") || "payroll", idempotencyKey, guarantorId: str(fd, "guarantorId") || null });
    return t.status === "posted" ? `Repayment ${t.reference} posted.` : `Repayment ${t.reference} awaiting checker approval.`;
  }, { revalidate: ["/accounts"] });
}

export async function waiverAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const component = str(fd, "component") === "interest" ? "interest" : "principal";
    const t = await proposeWaiver(await getDb(), actor, loanId, { component, amount: money(fd, "amount", "the amount"), reason: str(fd, "reason") });
    if (t.status === "posted") await realignSchedule(await getDb(), actor, loanId);
    return t.status === "posted" ? "Adjustment posted." : "Adjustment proposed; awaiting checker approval.";
  }, { revalidate: ["/accounts"] });
}

export async function refundAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await proposeRefund(await getDb(), actor, loanId, { amount: money(fd, "amount", "the amount"), reference: str(fd, "reference") });
    return t.status === "posted" ? "Refund posted." : "Refund proposed; awaiting checker approval.";
  }, { revalidate: ["/accounts"] });
}

export async function reversalAction(txnId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await proposeReversal(await getDb(), actor, txnId, str(fd, "reason"));
    if (t.status === "posted") await realignSchedule(await getDb(), actor, t.loanAccountId);
    return t.status === "posted" ? "Reversal posted." : "Reversal proposed; awaiting checker approval.";
  }, { revalidate: ["/accounts"] });
}

export async function approveTxnAction(txnId: string, _: Prev) {
  return runAction(async (actor) => {
    const t = await approvePendingTransaction(await getDb(), actor, txnId);
    return `${t.reference} approved and posted.`;
  }, { revalidate: ["/accounts"] });
}

export async function rejectTxnAction(txnId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const t = await rejectPendingTransaction(await getDb(), actor, txnId, str(fd, "reason"));
    return `${t.reference} rejected.`;
  }, { revalidate: ["/accounts"] });
}

export async function decideRestructureAction(requestId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const approve = str(fd, "decision") === "approve";
    await decideRestructure(await getDb(), actor, requestId, approve, str(fd, "comment") || (approve ? "Approved" : "Declined"));
    return approve ? "Restructure approved; new schedule active." : "Restructure request declined.";
  }, { revalidate: ["/accounts"] });
}

export async function runServicingAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    assertCan(actor, "servicing.run");
    const db = await getDb();
    const r = await runServicing(db, actor);
    const mail = bool(fd, "dispatch") ? await processOutbox(500) : null;
    const reminders = r.reminders + r.guarantorReminders + r.workReminders + r.escalations;
    const email = mail ? ` Emails: ${mail.sent} sent.` : "";
    return `Check complete: ${r.checked} ${r.checked === 1 ? "loan" : "loans"} checked, ${r.changes.length} status ${r.changes.length === 1 ? "change" : "changes"}, ${reminders} ${reminders === 1 ? "reminder" : "reminders"}.${email}`;
  }, { revalidate: ["/accounts"], limit: 5 });
}

/** Payroll deduction CSV import. CSV columns: staff_number, amount, reference[, value_date]. */
export async function importPayrollAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    assertCan(actor, "repayment.confirm");
    const f = file(fd, "csv");
    if (!f) throw new DomainError("Choose a CSV file.");
    if (f.size > 2 * 1024 * 1024) throw new DomainError("CSV must be under 2 MB.");
    const { rows, errors } = parseDeductionCsv(await f.text(), dateStr(fd, "valueDate", "value date"));
    const r = await postPayrollDeductions(await getDb(), actor, rows, `CSV import ${f.name}`);
    return summarise(r.posted, r.duplicates, [...errors, ...r.errors]);
  }, { revalidate: ["/accounts"], limit: 5 });
}

/** Pull and post a month's loan deductions from the payroll API (when configured). */
export async function syncPayrollAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    assertCan(actor, "repayment.confirm");
    const provider = payrollProvider();
    if (!provider) throw new DomainError("The payroll API is not configured. Use the CSV import.");
    const month = str(fd, "month", true);
    const r = await syncPayrollMonth(await getDb(), actor, provider, month);
    return summarise(r.posted, r.duplicates, r.errors);
  }, { revalidate: ["/accounts"], limit: 5 });
}

function summarise(posted: number, duplicates: number, errors: string[]) {
  return `Posted ${posted}, skipped ${duplicates} already-posted reference(s)${errors.length ? `, ${errors.length} error(s): ${errors.slice(0, 5).join("; ")}` : "."}`;
}