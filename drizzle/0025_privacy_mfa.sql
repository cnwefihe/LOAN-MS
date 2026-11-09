-- Privacy notice: name MFA instead of the placeholder. Edited notices are left alone.
UPDATE "terms_documents" SET "body" = replace("body", 'with [multi-factor authentication].', 'with MFA.')
WHERE "kind" = 'privacy_notice' AND "body" LIKE '%with [multi-factor authentication].%';
