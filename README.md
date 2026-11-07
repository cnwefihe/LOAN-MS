# Loan Management System

Pan-Atlantic University's system for the full staff-loan lifecycle:

**Eligibility check (including any cooperative loan) → Application → Guarantor acceptance → HR Administrator → Bursary Officer → Line Manager → HR Director → Bursar (final approval) → Accounts Payable Officer pays out → Repayments confirmed by the Bursary Officer → Closure**

Standard terms on the suggested products: 10% interest a year, repaid over at most 12 months, for staff with at least 24 months' service. Net pay must stay at or above 40% of gross after all deductions, including a declared cooperative loan deduction.

This follows the University's paper Employee Loan Application Form and Guarantor's Form, which the system replaces. Both forms can be downloaded from any application, filled from the record, including electronic signatures and each officer's decision.

Every stage is a recorded workflow transition. Every movement of money is a balanced double-entry ledger posting. Every sensitive action is written to an append-only audit log.

---

## 1. Architecture

| Layer | Technology | Notes |
|---|---|---|
| Web app | Next.js 16 (App Router), React 19, TypeScript | Server components and server actions. All authorisation runs on the server. |
| Styling | Tailwind CSS 4 | Design tokens in `src/app/globals.css`; the brand colour is set by administrators and applied at runtime. |
| Database | PostgreSQL 15+ through Drizzle ORM | Development and tests use **PGlite** (embedded Postgres) running the same migrations and triggers. |
| Auth | Microsoft Entra ID (OIDC auth-code + PKCE through `@azure/msal-node`) | Opaque, revocable, DB-backed sessions with idle and absolute timeouts. |
| Money | `decimal.js`, `numeric(18,2)` | Floats are never used for money. |
| Documents | AES-256-GCM encrypted private storage | Downloads only go through an authorised, logged route. |
| Exports | exceljs (XLSX), CSV, pdf-lib (PDF) | Role-restricted and audited. |

### Code map

```
src/
  db/schema.ts                 Relational schema (36 tables, FKs, indexes, checks)
  drizzle/                     SQL migrations, incl. 0001_integrity_triggers.sql
  lib/finance/                 Pure calculation engine: policy schema, eligibility, pricing, schedules
  lib/auth/                    Entra ID, sessions, permission catalogue
  server/workflow.ts           Approval workflow state machine
  server/services/
    applications.ts            Drafts, submission, guarantor nomination, messaging
    guarantors.ts              Guarantor responses, e-acknowledgement, exposure
    hr.ts                      Due diligence, staff directory
    approvals.ts               Multi-level approval, loan origination
    ledger.ts                  Double-entry posting, maker-checker, reversals, balances
    loans.ts                   Disbursement, repayments, claims, settlement, restructure, servicing
    policies.ts                Products and versioned policies
    documents.ts, reports.ts, admin.ts, identity.ts, staff.ts
  app/(app)/                   Role portals (see §3)
  app/api/                     Auth, document download, statements, exports, cron
tests/                         Calculation unit tests + full-lifecycle integration test
```

### Key design rules
- **Application ≠ approved loan ≠ ledger.** `loan_applications` is the request. `loan_accounts` is the approved contract and references the exact policy version it was priced under. `financial_transactions` and `ledger_entries` record what actually happened.
- **Only confirmed transactions change balances.** Staff-reported deductions (`repayment_claims`) stay pending until Accounts verifies them. Cached balances on `loan_accounts` are always recomputed from posted ledger entries inside the posting transaction.
- **Database-enforced integrity** (`drizzle/0001_integrity_triggers.sql`):
  - ledger entries, audit logs, workflow history, approvals and HR verifications are append-only;
  - posted or rejected transactions are frozen and can never be deleted;
  - every transaction's ledger lines must balance, checked at commit;
  - a maker can never also be the checker.
- **Corrections** are reversals or adjustments, never edits.
- **Idempotency.** Financial operations carry idempotency keys. External bank and payroll references are unique per transaction type, which blocks duplicate postings.

## 2. Roles

| Role | Can |
|---|---|
| Applicant (every staff member, auto-assigned) | Check eligibility, apply, upload documents, track progress, report deductions, request restructuring, download statements |
| Guarantor (auto-assigned when nominated) | Review invitations, accept with electronic signature, decline, request clarification, upload documents, see own exposure |
| HR Administrator | Verification queue, employment, salary and confirmation checks, guarantor capacity assessment, return, decline or forward; maintains staff records |
| Bursary Officer | Bursary review after HR (loan history, the take-home pay check and fund availability), then sends the application to the Line Manager; confirms reported repayments and records repayments; proposes settlements, waivers, refunds and reversals |
| Line Manager | Approves, declines or returns applications from their own department. Set per department under **Admin > Organisation**; not a role. A Line Manager applying for their own loan goes straight to the HR Director |
| HR Director | Approves, declines or returns applications after the Line Manager |
| Bursar | Final approval (amount or duration may be reduced), decline, return, refer to HR; approves pending transactions, decides restructuring, runs servicing |
| Accounts Payable Officer | Pays out loans once the Bursar has approved them; recording the payment activates the loan |
| Super Administrator | Users and roles, permission matrix, products and versioned policies (one administrator drafts, approves and opens products), organisation, terms and templates, settings, audit log, email outbox. **Deliberately has no financial checker rights.** |

Role titles and descriptions are set under **Admin > Roles**, and stage and menu names under **Admin > Settings > Workflow wording**. Changing them updates menus, queues, dashboards, approval history and printed forms; it never changes what a role is permitted to do.

Segregation of duties is enforced in the services:
- nobody can process their own application or loan;
- guarantors cannot verify or approve an application they guarantee;
- one person cannot approve at two stages of the same application, and the Bursary Officer who reviewed it cannot give final approval.

## 3. Portals

`/dashboard` · `/eligibility` · `/applications` · `/loans` · `/profile` · `/notifications` · `/search`: staff self-service
`/guarantor`: guarantor portal
`/hr`, `/hr/applications`, `/hr/staff`: Human Resources
`/approvals`: final approval
`/bursary/review`: Bursary review
`/accounts`, `/accounts/disbursements`, `/accounts/repayments`, `/accounts/approvals`, `/accounts/loans`, `/accounts/reconciliation`, `/accounts/servicing`: Bursary
`/reports`: analytics and exports
`/admin/*`: Super Administrator control centre

## 4. Local development

Requires Node.js 20.11+ (tested on Node 24).

```bash
npm install
cp .env.example .env.local      # then set AUTH_DEV_LOGIN=true, AUTH_SECRET, DATA_ENCRYPTION_KEY
npm run db:reset                # embedded DB + base data + DEVELOPMENT fixtures
npx tsx scripts/dev-walkthrough.ts   # optional: one fixture loan taken through the whole lifecycle
npm run dev                     # http://localhost:3000
```

Without Entra configured, `/login` offers **development fixture accounts**, clearly labelled. These are fictional seeded users, one per role. The fixture login is hard-disabled when `NODE_ENV=production`, and it only accepts users flagged `is_dev_fixture`.

```bash
npm test             # 123 tests: finance engine, full lifecycle, three-amount approval routing matrix, email delivery, branding, reports, two-step verification, return paths and
                     # document markings, servicing and default management, adapters, security hardening
npm run test:e2e     # 26 browser tests (Playwright): application to repayment across 8 users, receipts and verification, report downloads,
                     # emails, RBAC, axe WCAG 2.2 AA on 30 pages, no horizontal scrolling at 390/820/1366/1920 px
npm run branding     # rebuild logos and icons from the ./branding folder
npm run docs:samples # write sample receipt, statement, letter and executive summary PDFs to .data/sample-documents
npm run typecheck
npm run build
```

`npm run test:e2e` starts its own server on port 3100 with a throwaway database in `.data/e2e`. Install the browser once first with `npx playwright install chromium`.

## 5. Production deployment (recommended: Azure)

1. **Database:** Azure Database for PostgreSQL Flexible Server, TLS on, geo-redundant backups. Set `DATABASE_URL`.
2. **Secrets:** Azure Key Vault, referenced by App Service or Container Apps:
   - `AUTH_SECRET`
   - `DATA_ENCRYPTION_KEY` (32-byte base64; **back it up: documents cannot be decrypted without it**)
   - `CRON_SECRET`
   - `ENTRA_CLIENT_SECRET`
3. **Entra ID app registration:**
   - single tenant;
   - web redirect URI `https://<host>/api/auth/callback`;
   - delegated `User.Read`;
   - set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `APP_BASE_URL`.
4. **Email:**
   - grant the application permission `Mail.Send`;
   - restrict it with an Exchange `ApplicationAccessPolicy` to the sender mailbox;
   - set `EMAIL_TRANSPORT=graph` and `EMAIL_SENDER_ADDRESS`.
5. **Deploy:**

   ```bash
   npm ci && npm run build
   npm run db:migrate && npm run db:seed
   npm start
   ```

   `db:seed` installs base data only. Never run it with `--fixtures` in production.
6. **Bootstrap:** set `BOOTSTRAP_SUPER_ADMIN_EMAILS` for the first administrators and sign in. Then remove the variable.
7. **Scheduler:** on one server, the `scheduler` container in `docker-compose.yml` does this for you (see [docs/DEPLOY_PROXMOX.md](docs/DEPLOY_PROXMOX.md)). Otherwise: call `POST /api/cron/servicing` with `Authorization: Bearer $CRON_SECRET` every hour, and `POST /api/cron/reminders` with the same header every 5 minutes so reminder timings set in minutes are met. Each run is safe to repeat; it sends each reminder once, 24 hours after an item reached the person who has to act on it (and again each day until it is dealt with), and moves loans to overdue or default.
8. **Storage:** use `STORAGE_DIR` on an encrypted, backed-up volume. For multi-instance hosting, implement the Azure Blob adapter (interface in `src/server/storage.ts`).
9. **Before go-live:**
   - replace the **placeholder** loan terms and guarantor agreement (Admin → Terms & templates);
   - create the real loan products;
   - have the administrator approve their policies and open them.

   The seeded policy values are placeholders, not approved PAU policy.

### Backups and recovery
- **Database:** rely on PostgreSQL point-in-time restore (Flexible Server keeps 7–35 days). Take a nightly `pg_dump` to separate storage and test a restore quarterly.
- **Documents:** snapshot `STORAGE_DIR` (or enable Blob soft-delete and versioning) on the same schedule as the database. The DB holds each file's SHA-256, and downloads verify integrity.
- **Keys:** keep `DATA_ENCRYPTION_KEY` in Key Vault with soft-delete and purge protection.
- **Recovery order:** restore the database to a point in time → restore documents to the same point → redeploy → run `npm run db:migrate` (idempotent) → run servicing.

## 6. Security and data protection

- SSO only. No local passwords. The tenant is pinned, and PKCE, state and nonce are validated.
- Server-side RBAC on every page, action, download and export, re-read from the DB on every request.
- httpOnly session cookies (`__Host-` prefix in production), 10-minute inactivity sign-out (set in Settings, separately for administrators), 12-hour absolute lifetime, revocable by administrators.
- Security headers: CSP, HSTS, `frame-ancestors 'none'`, `nosniff`.
- DB-backed rate limiting on sign-in and on all mutations.
- Uploads are validated by magic bytes and size, then stored encrypted. Bank account numbers are encrypted at field level; only the last 4 digits are shown.
- CSV exports are neutralised against formula injection. Every export is audited.
- Personal and salary data access is limited by role, in line with the Nigeria Data Protection Act 2023. Remaining institutional steps: a DPIA, a records-retention schedule, and data subject request handling.

## 7. Integration status

Every variable and secret to set at deployment, with the Entra and Microsoft 365 steps, is in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Step-by-step setup for each integration is in **[docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md)**. Deployment, monitoring, backup and recovery are in **[docs/OPERATIONS.md](docs/OPERATIONS.md)**.

| Integration | Status |
|---|---|
| Microsoft Entra ID SSO | **Implemented, not yet tested against the PAU tenant.** Needs an app registration and credentials (section 1 of the setup guide). |
| Microsoft Graph user profile | Implemented (best effort). Pulls job title, department and employee ID on sign-in. |
| Institutional email (Microsoft 365, Graph sendMail) | **Implemented and tested end to end against a local double of the Microsoft token and sendMail endpoints; not yet connected to the PAU tenant.** Branded HTML with the logo inline. Until configured, emails are recorded as "not sent" and can be retried. Administration > Email outbox has a test-send button. |
| Payroll system | **Interface implemented; no live payroll API exists yet.** The HTTP adapter is tested against a local mock of the documented contract. The CSV import uses the same idempotent posting service. |
| Azure Blob storage | **Implemented and tested against Azurite** (Microsoft's storage emulator). Not yet run against a real PAU storage account. |
| General ledger / bank | Not integrated. The loan sub-ledger can be exported. |

## 8. Default management, data protection and administration

- **Default management:**
  - automatic overdue and default classification;
  - **call on guarantors**, which notifies each one of their pro-rata share;
  - recording **recoveries from a guarantor**;
  - **write-off** with maker-checker. A write-off is reversible to reinstate the loan, and guarantor exposure is released once it is approved.
- **Reminders:** repayment reminders before each due date, and guarantor reminders once per response period. Both are de-duplicated.
- **NDPA:**
  - staff can download all their data from Profile → *Download my data* (the download is audited);
  - a draft privacy notice is at `/privacy` (**the DPO must approve it**);
  - the daily job purges stale operational data under configurable retention settings. Financial and audit records are never purged.
- **Admin:**
  - Active sessions, with per-session revoke;
  - a document access log (including denied attempts);
  - email outbox dispatch and retry;
  - an integration status panel.
- **Ops:** `/api/health`, `Dockerfile` (standalone build), and GitHub Actions CI (`.github/workflows/ci.yml`).

### Policy engine options (set per product in Admin → Products & policies)
- **Repayment frequency:** monthly, every two months, or quarterly.
  - Tenors must be whole multiples of the period.
  - Affordability compares each instalment with the monthly deduction limit multiplied by the period.
  - Existing loans count towards obligations as a monthly-equivalent deduction.
- **Affordability (take-home rule):** after all loan repayments, including any share of loans the applicant guarantees, net pay must stay at or above 40% of gross pay (`affordabilityRule: take_home_floor`, `minTakeHomePercent: 40`). The older rule, deductions up to a percentage of pay (`deduction_cap`), remains available per product. The eligibility calculator works this out as staff type and explains each step; the Bursar sees the same check on the Bursary review.
- **Most a person can borrow:** the lower of what the take-home rule lets them repay over the chosen duration and the product's maximum amount. There is no separate share-of-salary limit.
- **Pricing:** interest only. The University charges no application or administration fees, so the full approved amount is paid out.
- **Approval routing by amount:** base approval levels apply to every request. Thresholds raise the number of levels for larger amounts, e.g. `[{"minAmount":"2000000","levels":2}]`. Each level must be approved by a different approver.
- **Deactivation:** an active policy version can be retired without a replacement. This closes the product to new applications; loans already approved keep their version.

### Staff-facing documents
- **Loan agreement** and **guarantor agreements** are generated at approval.
- A **disbursement advice** is generated at payout.
- **Repayment receipts** are available per confirmed payment. A receipt that has since been reversed is clearly marked as reversed.
- A **clearance letter** is available once a loan is fully settled, and states that guarantors are discharged.
- A **loan statement** can be downloaded at any time.

### Branding and document security
- **Identity is configurable** under Administration > Branding and documents: institution and system names, address, support contacts, primary colour (validated for contrast) and logos. The bundled logos come from `./branding` via `npm run branding`; uploaded logos take precedence.
- **Every PDF** (agreements, advices, receipts, statements, clearance letters, reports) carries the logo header, a bold diagonal CONFIDENTIAL watermark, and the footer "Pan-Atlantic University. Authorised User Only." with the document reference and page numbers. The marking, footer wording and watermark are configurable under Administration > Branding and documents; `{institution}` in the footer is replaced by the institution name.
- **Standard report layout**: every report PDF opens with a document control panel (basis, classification, preparer, data source, distribution), then numbered sections: executive summary, detail table with totals, notes and definitions, and a Prepared / Reviewed / Approved sign-off block. Excel (.xlsx) exports carry the same information on a "Report information" sheet, with formatted, filterable data and a totals row.
- **Report library** (Reports page): a monthly **Management Report** (portfolio position, repayment performance chart, arrears ageing, loans requiring attention, departmental distribution, guarantor exposure), the executive summary, and eleven registers: loan book, overdue and defaulted loans, arrears ageing, payroll deduction schedule, applications, disbursements, collections, repayment performance, departmental distribution, guarantor exposure and an audit log extract. Registers can be run for any period or payroll month, in PDF, Excel (.xlsx) or CSV.
- **Payroll deduction schedule**: for any month, the amount payroll should deduct from each borrower (instalment due plus any arrears already past due). Accounts can download it from the Reconciliation page, send it to payroll, and import the actual deductions afterwards.
- **Document register and verification**: every reference uses one format, LMS-YYMMDD-NNN (e.g. LMS-261101-001). The application and its loan account share one reference for life; payments and documents get their own number and always show the loan reference too. Each PDF's reference and its SHA-256 is recorded in an append-only register. Staff with document, Accounts or audit access can check a presented PDF at *Verify a document*.
- **Suggested products**: four draft products (personal, emergency, education, asset) are seeded for administrators to review, adjust and approve. Nothing opens to staff until the administrator approves and opens it.

### Accessibility note
The palette's secondary text colour `#64748B` measures 4.4:1 on the `#F5F7FA` background, which is below WCAG AA. Secondary text therefore uses `#5F6F86`, the closest shade that passes on every surface. Automated axe scans of 30 pages report no serious or critical issues. A manual screen-reader review is still recommended before go-live.
