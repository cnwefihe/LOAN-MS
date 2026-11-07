# Operations runbook

## Deployment

1. Build the image from the `Dockerfile`, or run `npm ci && npm run build`.
2. Apply migrations **before** starting the new version:
   - container: `node scripts/migrate.cjs`
   - from source: `npm run db:migrate`

   Migrations are forward-only and idempotent.
3. On first deployment only, run `node scripts/seed.cjs` (base data). **Never use `--fixtures` in production.**
4. Health check path: `/api/health`. It returns 200 when the database and document storage are reachable, and 503 otherwise.

## Monitoring

| Signal | Where |
|---|---|
| App health | `/api/health`, container HEALTHCHECK |
| Failed / unsent email | Admin → Email outbox |
| Servicing job ran today | Accounts → Servicing jobs (or audit action `servicing.run`) |
| Items stuck in queues | Badges in the sidebar; Accounts dashboard |
| Denied document access attempts | Admin → Audit log → Document access (`denied`) |
| Sensitive setting changes | Audit log, action `settings.sensitive_changed` |

## Backups

| Asset | Method | Frequency / retention |
|---|---|---|
| PostgreSQL | Azure Flexible Server automated backups (point-in-time restore) | Continuous; 35 days |
| PostgreSQL (offsite) | `pg_dump --format=custom` to a separate storage account | Nightly; 1 year (follow the records-retention schedule) |
| Documents | Blob versioning + soft delete (Azure); or nightly snapshot of `STORAGE_DIR` | Same as the database |
| `DATA_ENCRYPTION_KEY` | Key Vault with soft-delete + purge protection; offline copy in the Bursar's safe | Permanent |

Example nightly dump:

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="pau-loans-$(date +%F).dump"
az storage blob upload --account-name <backupacct> --container-name db-backups --file "pau-loans-$(date +%F).dump" --auth-mode login
```

## Recovery procedure

1. **Freeze writes.** Scale the app to 0 or enable maintenance at the gateway.
2. **Restore the database** to the chosen point in time:
   - Azure: Flexible Server → *Restore* → new server, then repoint `DATABASE_URL`;
   - or: `pg_restore --clean --no-owner -d "$DATABASE_URL" <dump>`.
3. **Restore documents** to the same point. For Blob, use version restore; for local storage, restore the snapshot. Documents created after the restore point will have no DB row. They are harmless orphans and can be listed and removed later.
4. Confirm `DATA_ENCRYPTION_KEY` is the **same key** used when the documents were written.
5. Deploy, then run the migrations. They are idempotent.
6. Check that `/api/health` = ok. Then open a loan's Ledger tab and confirm debits equal credits. Download one document to confirm decryption.
7. Run Accounts → Servicing → *Run now* to refresh statuses as of today.
8. Record the incident and the restore point in the audit or incident log. Any transactions entered after the restore point must be re-entered from source evidence. Payroll re-imports are idempotent.

Test this procedure **quarterly** on a non-production copy.

## Routine administration

- **Rotate the Entra client secret** before it expires (calendar reminder). No restart is needed if it is a Key Vault reference.
- **Policy changes:** create a new version, then have a second administrator approve it. Existing loans are unaffected.
- **Leavers:** deactivate the account in Admin → Users. This revokes sessions immediately. Then handle any outstanding loan through the default-management tools.
- **Annual access review:** export Admin → Users & roles and have the role owners recertify.
