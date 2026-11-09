-- Privacy notice: spell out Multi-Factor Authentication. Edited notices are left alone.
UPDATE "terms_documents" SET "body" = replace("body", 'with MFA.', 'with Multi-Factor Authentication.')
WHERE "kind" = 'privacy_notice' AND "body" LIKE '%with MFA.%';
