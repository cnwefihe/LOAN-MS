-- The Payroll Officer closes early repayments; the Payroll Manager oversees. Replace the first wording only where an administrator has not changed it.
UPDATE "roles"
SET "description" = 'Handles repayments and deductions: confirms the first salary deduction on each loan, and closes loans repaid in full early.'
WHERE "code" = 'PAYROLL_OFFICER'
  AND "description" = 'Confirms the first salary deduction on each loan; later deductions are then recorded automatically.';
--> statement-breakpoint
UPDATE "roles"
SET "description" = 'Oversees the Payroll Officer''s work on repayments and deductions, and the Bursary.'
WHERE "code" = 'PAYROLL_MANAGER'
  AND "description" = 'Oversees deductions and repayments, and marks loans repaid in full after an early repayment.';
