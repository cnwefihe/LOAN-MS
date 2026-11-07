-- Lets Super Administrators edit staff records. Administrators can turn this off again under Roles.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."code" = 'SUPER_ADMIN' AND p."code" = 'hr.staff.edit'
ON CONFLICT DO NOTHING;
