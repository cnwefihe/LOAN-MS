/**
 * The University's privacy notice, as supplied. Published by migration 0023 and editable under
 * Templates > Privacy notice. Format: "## " heading, "- " list item, "a | b" table rows (first row is
 * the header), **bold**. {institution}, {system} and {dpo} are filled in when the notice is shown.
 */
export const DEFAULT_PRIVACY_TITLE = "Loan Management System privacy notice";

export const DEFAULT_PRIVACY_BODY = `## Who we are
Pan-Atlantic University ("the University", "we", "us") is the data controller for personal data processed in the Loan Management System ("the System"). We process it in line with the Nigeria Data Protection Act 2023 (NDPA) and the General Application and Implementation Directive 2025 (GAID).

## What this notice covers
This notice explains what personal data the System processes about you, why we process it, who sees it, where it goes, how long we keep it and what rights you have. It applies whether you are a borrower or a guarantor.

## What we process, and where it comes from
Category | Examples | Where it comes from
Identity and account | Name, work email, directory job title and department | Your Microsoft 365 account
Employment | Staff number, department, designation, employment status, start and end dates, contract type | Human Resources records
Pay and obligations | Basic, gross and net salary, existing loan deductions, other statutory or contractual deductions | Payroll and Human Resources
Bank details | Account name, bank, account number (stored encrypted; only the last four digits are displayed) | You
Application and loan records | Amount, purpose, tenor, guarantor details, approvals, offer, disbursement, repayment schedule, ledger, arrears | You, the approvers and the System
Supporting documents | Payslips, identification, signed agreements, evidence supporting the loan purpose | You and your guarantor
Guarantor data | Name, staff number, employment details, salary information relevant to the guarantee, consent or signature | The guarantor, Human Resources and you
Messages and notifications | Messages exchanged in the System, system notices, email copies | You, approvers and the System
Security and audit | Sign-in sessions, IP address, browser type, timestamps, a record of actions taken in the System | Generated automatically

**Sensitive information.** The System is not designed to collect health, religious, trade-union or other sensitive personal data. If your loan purpose or supporting documents contain such data (for example a medical bill), please share only what is necessary. We will treat it as sensitive, restrict access to the approving staff who need it, and process it only on a lawful condition permitted by the NDPA.

## Why we use your data, and our lawful basis
Purpose | Lawful basis
Assessing eligibility, approving, disbursing and servicing your loan | Performance of the loan agreement with you, and steps you request before entering it
Recovering repayments, including by payroll deduction, and handling arrears | Performance of the loan agreement, and your written authorisation for deductions
Managing guarantees and, where needed, calling on a guarantor | Performance of the guarantor agreement
Maintaining financial records, auditing, tax and regulatory reporting | Legal obligation
Protecting the System against fraud, misuse and security incidents, and keeping an audit trail | Legitimate interest in the security and integrity of the University's finances, balanced against your rights. A documented legitimate-interest assessment is available from the DPO on request.
Establishing, exercising or defending legal claims | Legal obligation or legitimate interest, as applicable

**Consent.** We do not rely on your consent for the core loan processing, because an employment relationship can make consent unreliable. Applying for a loan is voluntary. If we introduce an optional feature that relies on consent, we will ask separately, and you may withdraw that consent at any time.

**Purpose limitation.** We use loan data only for the purposes above. We do not use it for performance appraisal, promotion or disciplinary decisions, except where the law requires disclosure or the matter concerns fraud or breach of the loan agreement.

## Automated processing
The System calculates eligibility indicators, such as the ratio of your proposed deductions to your net pay, and generates repayment schedules automatically, with human review. No application is declined solely by automated means: a trained officer reviews any adverse outcome. You may ask for human review, express your view and contest a decision by contacting the DPO.

## Who can see it
Access to information on the platform is role-based, need-to-know:

Role | What they see and why
Human Resources | Employment and identity data, to verify eligibility
Approving authority | Application, repayment capacity indicators and guarantor details, to decide
Bursary / Finance | Bank details, disbursement, repayment and ledger records
Payroll | Deduction instructions, to implement repayments
Internal Audit and Internal Control | Records needed for control testing and audit
System administrators | Configuration and support. They cannot read salary, bank or document content in the ordinary course; any exceptional access is approved and logged.
Data Protection Officer | Records needed to handle rights requests, complaints and incidents
Guarantors | Only the loan details relevant to their obligation (Section 11)

Every access to documents is logged. Data is not sold or shared outside the University except where required by law.

## How long we keep it
Loan, ledger and audit records are kept for the period set in the University's records-retention schedule for financial records. Operational data (read notifications, expired sessions, delivered email copies) is deleted automatically after the periods configured by the administrators.

## How we protect your data
We apply technical and organisational measures proportionate to the risk, including:

- Sign-in through your institutional Microsoft account, with [multi-factor authentication].
- Encryption of data in transit. Documents and bank account numbers are additionally encrypted at rest, and the database and backups are encrypted at rest.
- Role-based access checked on the server for every request, with periodic access reviews.
- Financial entries designed to be tamper-resistant: they are not edited in place, and corrections are made by traceable reversal entries. Access to documents and sensitive actions is logged, and the logs are protected from alteration.
- Backups, security testing and monitoring.

## Your rights
You may access, correct or object to the processing of your data, or lodge a complaint with the Nigeria Data Protection Commission. You can download a copy of your data at any time from My profile by selecting "Download my data". For corrections or other requests, contact the Data Protection Officer by email at {dpo}.

Right | What it means
Be informed | Receive this notice and be told of material changes
Access | Get confirmation that we process your data, a copy of it and information about its use
Rectification | Correct inaccurate or incomplete data
Erasure | Ask us to delete data that is no longer necessary or is processed unlawfully (not where we must keep it for legal or audit reasons)
Restriction | Ask us to pause processing while accuracy or lawfulness is checked
Objection | Object to processing based on legitimate interest, and to direct marketing (we do not do marketing)
Portability | Receive data you gave us in a structured, commonly used, machine-readable format
Withdraw consent | Withdraw any consent you gave, without affecting earlier lawful processing
Human review | Not be subject to a solely automated decision with significant effects without safeguards

**How to exercise them.** Use My profile → Download my data on your dashboard for an immediate copy of your data. For any other requests, you can contact the Data Protection Officer by email at {dpo}. We may ask you to verify your identity. We will respond without undue delay and within one month, telling you if we need more time or cannot grant a request, and why. There is no charge unless a request is manifestly unfounded or excessive.

Users also have the right to file complaints with the Nigeria Data Protection Commission where the actions of the Data Protection Officer have been deemed unsatisfactory within the appropriate period.

## Changes to this notice
We will update this notice when our processing changes and will notify System users of material changes through the System and by email before they take effect.`;

export function fillPrivacy(text: string, v: { institution: string; system: string; dpo: string }) {
  return text.replaceAll("{institution}", v.institution).replaceAll("{system}", v.system).replaceAll("{dpo}", v.dpo);
}
