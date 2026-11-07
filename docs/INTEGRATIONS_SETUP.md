# Integration setup: ICT runbook

These steps connect the platform to PAU's Microsoft 365 tenant, email, Azure storage and payroll. Each one needs tenant or subscription administrator rights, so it can only be done by PAU ICT. When an integration is configured, the platform reports it under **Administration > Control centre > Integration status**.

---

## 1. Microsoft Entra ID single sign-on

**Portal:** Entra admin centre > *App registrations* > *New registration*

| Setting | Value |
|---|---|
| Name | `Loan Management System` |
| Supported account types | **Accounts in this organizational directory only** (single tenant) |
| Redirect URI | Platform **Web**, `https://<host>/api/auth/callback` |

Then:

1. **Certificates & secrets** > *New client secret*. Use a 12-month expiry and set a calendar reminder to rotate it. Store the secret in Key Vault as `ENTRA-CLIENT-SECRET`.
2. **API permissions** > Microsoft Graph > *Delegated* > `User.Read` > *Grant admin consent*.
3. **Token configuration** (optional) > add the optional claim `email` to the ID token.
4. **Front-channel logout URL:** `https://<host>/login?signedOut=1`.
5. *(Recommended)* **Enterprise applications** > the app > *Properties* > **Assignment required = Yes**. Then assign the "All Staff" group so that students and guests can't sign in.
6. *(Recommended)* Add a Conditional Access policy requiring MFA for this app.

Set the app settings:

```
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=@Microsoft.KeyVault(SecretUri=...)
APP_BASE_URL=https://<host>
ALLOWED_EMAIL_DOMAINS=example.edu.ng
BOOTSTRAP_SUPER_ADMIN_EMAILS=<first two administrators>   # remove after first sign-in
```

**Verify:**
1. Sign in at `/login` with a staff account.
2. Confirm the user appears in *Administration > Users and roles* with the Applicant role.
3. Confirm the audit log shows `user.provisioned`.
4. Sign in with a non-PAU or guest account and confirm it is refused.

Equivalent Azure CLI:

```bash
az ad app create --display-name "Loan Management System" --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://<host>/api/auth/callback"
az ad app permission add --id <appId> --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope   # User.Read
az ad app permission admin-consent --id <appId>
az ad app credential reset --id <appId> --years 1 --append
```

## 2. Institutional email (Microsoft 365)

Full steps, including the recommended separate app registration and how to restrict it to one shared mailbox (RBAC for Applications, or an application access policy), are in [DEPLOYMENT.md, section 5](DEPLOYMENT.md#5-email-through-microsoft-365).

In short:

```
EMAIL_TRANSPORT=graph
EMAIL_SENDER_ADDRESS=loans@example.edu.ng
EMAIL_GRAPH_TENANT_ID=<tenant ID>
EMAIL_GRAPH_CLIENT_ID=<email app client ID>
EMAIL_GRAPH_CLIENT_SECRET=@Microsoft.KeyVault(SecretUri=...)
```

**Verify:** Administration > Email outbox > **Send a test email**. To re-send anything that was queued before email was connected, use *Retry failed or unsent*.

## 3. Azure Blob document storage (needed when running more than one instance)

1. Create a Storage account with these settings:
   - StorageV2;
   - **Allow Blob public access = Disabled**;
   - minimum TLS 1.2;
   - **blob versioning, blob soft delete (30 days) and container soft delete** enabled.
2. Create the container `loan-documents` with access level **Private**.
3. Enable the app's **system-assigned managed identity**, then assign it **Storage Blob Data Contributor** on the container.
4. Set:

   ```
   STORAGE_BACKEND=azure
   AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
   AZURE_STORAGE_CONTAINER=loan-documents
   ```

   Use `AZURE_STORAGE_CONNECTION_STRING` only if managed identity is unavailable.
5. **Migrating from local storage:** copy the existing `storage/` tree into the container with the **same relative paths**, for example:

   ```
   azcopy copy "storage/*" "https://<account>.blob.core.windows.net/loan-documents" --recursive
   ```

   Files are already encrypted, so they are copied as-is.

**Verify:** `GET /api/health` returns `checks.documents.ok = true`. Then upload and download a document.

Documents are encrypted with `DATA_ENCRYPTION_KEY` before upload, so the storage account only ever holds ciphertext.

## 4. Payroll system

The platform needs two read-only endpoints from the payroll vendor or ICT. The exact contract is documented in `src/server/integrations/payroll.ts`:

- `GET /deductions?month=YYYY-MM&code=<loan deduction code>` returns the month's staff-loan deductions (staff number, amount, unique payroll reference, value date)
- `GET /staff/{staffNumber}/salary` returns current basic, gross and net pay

Set:

```
PAYROLL_API_BASE_URL=...
PAYROLL_API_KEY=...
PAYROLL_LOAN_DEDUCTION_CODE=...
```

Once set, Accounts gets **Sync from payroll system** on the Reconciliation page, and HR gets **Fetch salary from payroll** on staff records.

Until the API exists, Accounts uploads the monthly deduction CSV, with columns `staff_number,amount,reference,value_date`. It goes through the same posting service, and re-imports are idempotent on the payroll reference.

If the vendor's JSON shape differs, only the two mapping functions in `payroll.ts` need changing.

## 5. Daily servicing schedule

Use an Azure Logic App (Recurrence trigger, 06:00 W. Central Africa Time) or any scheduler:

```
POST https://<host>/api/cron/servicing
Authorization: Bearer <CRON_SECRET>
```

The job does the following:
- refreshes days past due and overdue/default statuses;
- sends repayment and guarantor reminders;
- purges stale operational data (per the retention settings);
- dispatches queued email.

Each run is logged under Accounts > Servicing jobs.
