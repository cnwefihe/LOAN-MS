-- Two-step verification becomes a choice under Settings > Security, starting with everyone.
INSERT INTO "system_settings" ("key", "value", "description", "is_sensitive")
VALUES ('security.mfaScope', '"everyone"'::jsonb, 'Require two-step verification for', true)
ON CONFLICT ("key") DO UPDATE SET "value" = '"everyone"'::jsonb;
--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" = 'security.mfaRequired';
