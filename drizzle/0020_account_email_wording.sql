-- Account emails point people to the Administrator. Only the original wording is replaced, so edited templates are kept.
UPDATE "notification_templates"
SET "body" = replace("body", 'please contact the support team.', 'please contact the Administrator.')
WHERE "code" IN ('account.created', 'account.role_removed', 'account.deactivated')
  AND "body" LIKE '%please contact the support team.%';
