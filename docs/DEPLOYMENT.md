# Deployment and go-live guide

On a Proxmox server, follow **[CI_CD.md](CI_CD.md)** and **[DEPLOY_PROXMOX.md](DEPLOY_PROXMOX.md)**, and use this guide for the Microsoft set-up. This guide lists everything to create before the Loan Management System goes live: the app registrations, the variables and secrets to set on the host, and the first-day configuration in the Administration area. Detailed portal steps for each integration are in [INTEGRATIONS_SETUP.md](INTEGRATIONS_SETUP.md); day-to-day running is in [OPERATIONS.md](OPERATIONS.md).

## 1. Checklist

| # | Task | Who |
|---|---|---|
| 1 | PostgreSQL 15+ database (for example Azure Database for PostgreSQL Flexible Server) with automated backups | ICT |
| 2 | Microsoft Entra app registration for **sign-in** (section 4) | Entra administrator |
| 3 | Shared mailbox and a second app registration for **email** (section 5) | Exchange administrator |
| 4 | Azure Key Vault holding every secret in section 3 | ICT |
| 5 | Host: Azure Container Apps or App Service for Containers, using the `Dockerfile` | ICT |
| 6 | Azure Blob container for documents if more than one instance will run | ICT |
| 7 | Daily scheduler calling the servicing job (section 6) | ICT |
| 8 | First sign-in, branding, products and roles (section 7) | Super Administrators |

## 2. How the pieces fit

```
Staff browser ──HTTPS──> Loan Management System ──> PostgreSQL
                              │   │   └──────────> Azure Blob (encrypted documents)
                              │   └──> Microsoft Entra ID (sign-in, OpenID Connect + PKCE)
                              └──────> Microsoft Graph sendMail (email, as the shared mailbox)
```

## 3. Variables and secrets

Set these as application settings on the host. Values marked **Secret** must come from Key Vault (for example `@Microsoft.KeyVault(SecretUri=...)` on App Service) and must never be committed.

### Required

| Variable | Secret | Example or how to obtain |
|---|---|---|
| `NODE_ENV` | No | `production` |
| `APP_BASE_URL` | No | `https://loans.example.edu.ng` (no trailing slash). Used for the sign-in redirect and links in emails. |
| `DATABASE_URL` | **Secret** | `postgres://user:password@host:5432/loans?sslmode=require` |
| `AUTH_SECRET` | **Secret** | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATA_ENCRYPTION_KEY` | **Secret** | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Encrypts documents and bank details. Back it up: data cannot be read without it. |
| `CRON_SECRET` | **Secret** | Any random string of 32 characters or more |
| `ENTRA_TENANT_ID` | No | Directory (tenant) ID, from the sign-in app registration |
| `ENTRA_CLIENT_ID` | No | Application (client) ID of the sign-in app |
| `ENTRA_CLIENT_SECRET` | **Secret** | Client secret of the sign-in app |
| `ALLOWED_EMAIL_DOMAINS` | No | `example.edu.ng` (comma-separated if more than one) |

### Email through Microsoft 365

| Variable | Secret | Example or how to obtain |
|---|---|---|
| `EMAIL_TRANSPORT` | No | `graph` (leave unset to record emails without sending) |
| `EMAIL_SENDER_ADDRESS` | No | `loans@example.edu.ng` (the shared mailbox) |
| `EMAIL_GRAPH_TENANT_ID` | No | Usually the same tenant ID as above |
| `EMAIL_GRAPH_CLIENT_ID` | No | Application (client) ID of the **email** app registration |
| `EMAIL_GRAPH_CLIENT_SECRET` | **Secret** | Client secret of the email app registration |

If the three `EMAIL_GRAPH_*` values are not set, the sign-in app's `ENTRA_*` credentials are used instead. A separate email app is recommended so that the sign-in app never holds a mail permission.

### Optional

| Variable | Purpose |
|---|---|
| `BOOTSTRAP_SUPER_ADMIN_EMAILS` | Comma-separated emails made Super Administrator at first sign-in. Set for go-live, then remove. |
| `STORAGE_BACKEND`, `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER` | `azure` plus the account URL (managed identity) for Azure Blob. `AZURE_STORAGE_CONNECTION_STRING` (**Secret**) if managed identity is unavailable. Default is encrypted local files in `STORAGE_DIR`. |
| `DATABASE_POOL_MAX`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED`, `DB_AUTO_MIGRATE` | Database tuning. Run migrations as a deployment step rather than enabling auto-migrate. |
| `PAYROLL_API_BASE_URL`, `PAYROLL_API_KEY` (**Secret**), `PAYROLL_LOAN_DEDUCTION_CODE` | Payroll API, when one exists. CSV import works without it. |
| `GRAPH_BASE_URL`, `ENTRA_AUTHORITY_HOST` | Only for national clouds. Leave unset for the global Microsoft cloud. |

Never set `AUTH_DEV_LOGIN` in production. The development sign-in panel is disabled whenever `NODE_ENV=production`, whatever the value.

## 4. Sign-in app registration (Microsoft Entra ID)

Entra admin centre > App registrations > New registration:

| Setting | Value |
|---|---|
| Name | `Loan Management System` |
| Supported account types | Accounts in this organisational directory only (single tenant) |
| Redirect URI | Web: `{APP_BASE_URL}/api/auth/callback` |
| API permissions | Microsoft Graph, **Delegated**, `User.Read`, then Grant admin consent |
| Front-channel logout URL | `{APP_BASE_URL}/login?signedOut=1` |

Create a client secret (12-month expiry, with a rotation reminder) and store it in Key Vault as `ENTRA_CLIENT_SECRET`. Recommended: set *Assignment required* to Yes on the enterprise application and assign the all-staff group, and require MFA with Conditional Access.

**Two-step verification.** Choose who needs it under Admin > Settings > Security: **Everyone** (the default), **Approval and payment roles**, or **No one**. Changing it needs confirmation and is recorded under Activity.
- If Microsoft already performed MFA at sign-in (the token's `amr` claim contains `mfa`), that counts and they are not asked again. A Conditional Access policy requiring MFA for this application is therefore the smoothest option.
- Otherwise they set up an authenticator app (Microsoft Authenticator recommended) on first sign-in, receive eight one-time recovery codes, and enter a six-digit code at each sign-in.
- A Super Administrator can reset it under Administration > Users, for example after a lost phone. The requirement can only be switched off under Settings > Security, with explicit confirmation, and the change is audited.

## 5. Email through Microsoft 365

1. Create a shared mailbox, for example `loans@example.edu.ng`. It needs no licence and nobody signs in to it.
2. Create a second app registration, `Loan Management System Mail`. Single tenant, no redirect URI. Create a client secret and store it in Key Vault as `EMAIL_GRAPH_CLIENT_SECRET`.
3. Allow that app to send **only** as the shared mailbox. Use one of these two methods.

   **Recommended: RBAC for Applications in Exchange Online.** Do *not* add Mail.Send in Entra; the Exchange role assignment grants it, limited to the mailbox. In Exchange Online PowerShell:

   ```powershell
   Connect-ExchangeOnline
   # Object ID from Entra > Enterprise applications > Loan Management System Mail
   New-ServicePrincipal -AppId <email-app-client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Loan Management System Mail"
   New-ManagementScope -Name "Loans mailbox only" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'loans@example.edu.ng'"
   New-ManagementRoleAssignment -App <email-app-client-id> -Role "Application Mail.Send" -CustomResourceScope "Loans mailbox only"
   Test-ServicePrincipalAuthorization -Identity <email-app-client-id> -Resource loans@example.edu.ng       # InScope: True
   Test-ServicePrincipalAuthorization -Identity <email-app-client-id> -Resource someone.else@example.edu.ng # InScope: False
   ```

   **Alternative: application access policy.** Grant the Graph *Application* permission `Mail.Send` with admin consent, then restrict it:

   ```powershell
   New-DistributionGroup -Name "Loans Mail Senders" -Type Security -Members loans@example.edu.ng
   New-ApplicationAccessPolicy -AppId <email-app-client-id> -PolicyScopeGroupId "Loans Mail Senders" -AccessRight RestrictAccess -Description "Loan Management System may only send as loans@"
   Test-ApplicationAccessPolicy -AppId <email-app-client-id> -Identity loans@example.edu.ng   # Granted
   ```

4. Set `EMAIL_TRANSPORT=graph`, `EMAIL_SENDER_ADDRESS` and the three `EMAIL_GRAPH_*` values, then restart the app.
5. Check delivery: Administration > Email outbox > **Send a test email**. The page states whether delivery is configured and, if Microsoft rejects a message, shows Microsoft's reason (for example a wrong secret or a missing permission).

Every email is branded with the logo and colours from Administration > Branding and documents, ends with the sign-off from System settings, and has a short footer naming the system and the University.

## 6. Build, migrate and schedule

```bash
docker build -t loan-management-system .
docker run --rm --env-file prod.env loan-management-system node scripts/migrate.cjs   # database migrations
docker run --rm --env-file prod.env loan-management-system node scripts/seed.cjs      # roles, settings, templates, suggested products
docker run -p 3000:3000 --env-file prod.env loan-management-system
```

Migrations and the base seed are safe to run on every release: they never overwrite administrator changes.

What the base seed installs, once, for the administrators to keep or edit: roles and permissions, notification templates, system settings and wording, the four products (open), the payslip document requirement, sample schools, departments and staff categories, and placeholder loan terms and guarantor agreement. Anything an administrator changes or deletes is never put back by a later release. The demonstration accounts (the `.dev@example.edu.ng` people and their sample payslips) and the internal test product are never installed in production: the seed refuses to create them, and the demonstration sign-in is switched off. Staff sign in with their University Microsoft accounts, and the Super Administrator assigns roles under **Administration > Users and roles**.

Daily servicing (overdue and default status, reminders, housekeeping, email retries), for example from an Azure Logic App at 06:00 West Africa Time:

```
POST {APP_BASE_URL}/api/cron/servicing
Authorization: Bearer {CRON_SECRET}
```

Health check for the load balancer: `GET /api/health`.

## 7. First-day configuration (Super Administrators)

1. Sign in with an address listed in `BOOTSTRAP_SUPER_ADMIN_EMAILS`. Then remove that variable.
2. **Administration > Branding and documents.** Confirm the institution name, system name, address, support contacts and brand colour. Upload replacement logos if needed (the files in the `branding` folder are used by default). Change the document security marking and footer notice if required. Use **Preview a sample PDF** to check the result.
3. **Administration > Products and policies.** The four products are installed open, with the values configured before go-live: Personal Loan and Asset Loan (10% a year, reducing balance, tenor 1 to 12 months, two guarantors), Bereavement Loan (interest-free) and the Salary, Leave Allowance and 13th Month Advance (interest-free, confirmed staff only, no guarantors). There is no fixed loan amount: what each person can borrow is worked out from their latest payslip (all deductions, including the loan, subject to a maximum of 33.3% of net pay). To change a value, start a new version, submit it and approve it; to stop offering a product, close it.
4. **Administration > Terms and templates.** Replace the placeholder loan terms and guarantor agreement with the approved legal text, and adjust email wording if wanted.
5. **Administration > Organisation.** Sample schools, departments and staff categories are installed so the structure is ready to edit. Rename, add or remove them to match the University.
6. **Administration > Users and roles.** Assign the HR Administrator, Bursary Officer, HR Director, Bursar and Accounts Payable Officer roles to different people. Then, under **Administration > Organisation**, set the Head of each department: applications cannot pass the Bursary Officer until the applicant's department has a Head.
7. **Administration > System settings.** Review the financial controls, session limits, retention periods and the privacy contact. Use the announcement banner to tell staff the system is open.
8. **Administration > Email outbox.** Send a test email.

## 8. Before opening to all staff

- Restore a database backup into a test server and confirm the app starts against it.
- Have the Data Protection Officer approve the privacy notice (shown at `/privacy`).
- Run one loan through end to end with real staff in each role, using a small amount.
- Record the client secret expiry dates and the Key Vault location of `DATA_ENCRYPTION_KEY`.
