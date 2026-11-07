/**
 * Payroll integration boundary.
 *
 * PAU's payroll system has no API connected yet. The platform depends only on this interface:
 *   - CsvPayrollSource parses the monthly deduction file Accounts exports from payroll (in use today).
 *   - HttpPayrollProvider talks to a payroll REST endpoint implementing the contract below. It is
 *     tested against a local mock server only, NOT against the real payroll system.
 *
 * Expected REST contract (adapt the mapping functions if the vendor's shape differs):
 *   GET {PAYROLL_API_BASE_URL}/deductions?month=YYYY-MM&code={PAYROLL_LOAN_DEDUCTION_CODE}
 *       → [{ "staffNumber": "1234", "amount": "87500.00", "reference": "PR-2026-10-1234", "valueDate": "2026-10-25" }]
 *   GET {PAYROLL_API_BASE_URL}/staff/{staffNumber}/salary
 *       → { "staffNumber": "1234", "monthlyBasic": "300000.00", "monthlyGross": "450000.00", "monthlyNet": "380000.00", "asOf": "2026-10-01" }
 *   Auth: "Authorization: Bearer {PAYROLL_API_KEY}"
 */
import { parseMoneyInput } from "@/lib/finance/money";
import { DomainError } from "../errors";

export interface PayrollDeduction { staffNumber: string; amount: string; reference: string; valueDate: string }
export interface PayrollSalary { staffNumber: string; monthlyBasic: string; monthlyGross: string; monthlyNet: string; asOf: string }

export interface PayrollProvider {
  readonly name: string;
  fetchDeductions(month: string): Promise<PayrollDeduction[]>;
  fetchSalary(staffNumber: string): Promise<PayrollSalary | null>;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function normaliseDeduction(raw: Record<string, unknown>, fallbackDate: string): PayrollDeduction {
  const staffNumber = String(raw.staffNumber ?? raw.staff_number ?? "").trim();
  const reference = String(raw.reference ?? "").trim();
  const valueDate = String(raw.valueDate ?? raw.value_date ?? fallbackDate).trim();
  if (!staffNumber || !reference) throw new DomainError("Payroll row is missing staff number or reference.");
  if (!ISO.test(valueDate)) throw new DomainError(`Invalid value date "${valueDate}" for ${staffNumber}.`);
  return { staffNumber, amount: parseMoneyInput(String(raw.amount ?? "")), reference, valueDate };
}

export class HttpPayrollProvider implements PayrollProvider {
  readonly name = "payroll-api";
  constructor(private baseUrl: string, private apiKey: string, private deductionCode?: string, private timeoutMs = 15_000) {}

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new DomainError(`Payroll system responded ${res.status}. Try again later or use the CSV import.`);
    return res.json();
  }

  async fetchDeductions(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new DomainError("Month must be YYYY-MM.");
    const q = new URLSearchParams({ month, ...(this.deductionCode ? { code: this.deductionCode } : {}) });
    const data = await this.get(`/deductions?${q}`);
    if (!Array.isArray(data)) throw new DomainError("Unexpected payroll response (expected a list of deductions).");
    return data.map((r) => normaliseDeduction(r as Record<string, unknown>, `${month}-25`));
  }

  async fetchSalary(staffNumber: string) {
    const data = (await this.get(`/staff/${encodeURIComponent(staffNumber)}/salary`)) as Record<string, unknown> | null;
    if (!data) return null;
    return {
      staffNumber,
      monthlyBasic: parseMoneyInput(String(data.monthlyBasic)),
      monthlyGross: parseMoneyInput(String(data.monthlyGross)),
      monthlyNet: parseMoneyInput(String(data.monthlyNet)),
      asOf: String(data.asOf ?? ""),
    };
  }
}

export function payrollProvider(): PayrollProvider | null {
  const { PAYROLL_API_BASE_URL, PAYROLL_API_KEY, PAYROLL_LOAN_DEDUCTION_CODE } = process.env;
  if (!PAYROLL_API_BASE_URL || !PAYROLL_API_KEY) return null;
  return new HttpPayrollProvider(PAYROLL_API_BASE_URL, PAYROLL_API_KEY, PAYROLL_LOAN_DEDUCTION_CODE);
}

/** Parse the monthly deduction CSV: staff_number, amount, reference[, value_date]. Returns rows and per-row parse errors. */
export function parseDeductionCsv(text: string, defaultDate: string): { rows: PayrollDeduction[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = (lines.shift() ?? "").replace(/^﻿/, "").toLowerCase().split(",").map((h) => h.trim());
  const idx = (k: string) => header.indexOf(k);
  if (idx("staff_number") < 0 || idx("amount") < 0 || idx("reference") < 0) throw new DomainError("CSV header must include staff_number, amount, reference (and optionally value_date).");
  const rows: PayrollDeduction[] = [];
  const errors: string[] = [];
  lines.forEach((line, n) => {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    try {
      rows.push(normaliseDeduction({ staffNumber: cols[idx("staff_number")], amount: cols[idx("amount")], reference: cols[idx("reference")], valueDate: idx("value_date") >= 0 && cols[idx("value_date")] ? cols[idx("value_date")] : defaultDate }, defaultDate));
    } catch (err) {
      errors.push(`Row ${n + 2}: ${(err as Error).message}`);
    }
  });
  return { rows, errors };
}
