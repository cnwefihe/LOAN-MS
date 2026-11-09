ALTER TABLE "users" ADD COLUMN "name_locked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "users" u SET "display_name" = trim(sp."payslip_name"), "name_locked" = true
FROM "staff_profiles" sp
WHERE sp."user_id" = u."id" AND coalesce(trim(sp."payslip_name"), '') <> ''
  AND EXISTS (SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."role_id" WHERE ur."user_id" = u."id" AND r."code" = 'SUPER_ADMIN');
