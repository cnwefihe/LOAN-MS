-- Administrators no longer see salaries, payslips, staff records or uploaded documents, as the privacy notice states.
DELETE FROM "role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'SUPER_ADMIN')
  AND "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" IN ('hr.queue.view', 'hr.staff.view', 'hr.staff.edit', 'approval.queue.view', 'documents.view_all'));
--> statement-breakpoint
UPDATE "terms_documents"
SET "body" = replace("body", '[CONFIRM: they cannot read salary, bank or document content in the ordinary course; any exceptional access is approved and logged.]', 'They cannot read salary, bank or document content in the ordinary course; any exceptional access is approved and logged.')
WHERE "kind" = 'privacy_notice' AND "body" LIKE '%[CONFIRM: they cannot read salary%';
