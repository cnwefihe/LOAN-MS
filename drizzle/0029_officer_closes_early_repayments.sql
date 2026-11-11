-- The Payroll Officer closes loans repaid in full early; the Payroll Manager oversees.
DELETE FROM "role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'PAYROLL_MANAGER')
  AND "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'settlement.confirm');
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."code" = 'PAYROLL_OFFICER' AND p."code" = 'settlement.confirm'
ON CONFLICT DO NOTHING;
