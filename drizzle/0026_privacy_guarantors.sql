-- Privacy notice: a section on what guarantors see, in place of the reference to a missing Section 11.
UPDATE "terms_documents" SET "body" = replace("body", '(Section 11)', '(see "What guarantors see" below)')
WHERE "kind" = 'privacy_notice' AND "body" LIKE '%(Section 11)%';
--> statement-breakpoint
UPDATE "terms_documents" SET "body" = replace("body", 'except where required by law.' || chr(10) || chr(10) || '## How long we keep it', 'except where required by law.' || chr(10) || chr(10) || '## What guarantors see
A guarantor sees what they need to decide and to understand their obligation: the borrower''s name, department, designation, length of service and contact details (phone, email and residential address); the loan purpose, amount, tenor, instalment and total repayable; the share they guarantee; the loan''s repayment status; and the loan agreement and the documents supporting the loan purpose. A guarantor does not see the borrower''s salary, payslip or bank details.' || chr(10) || chr(10) || '## How long we keep it')
WHERE "kind" = 'privacy_notice' AND "body" NOT LIKE '%## What guarantors see%';
