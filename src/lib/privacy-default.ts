/**
 * The starting privacy notice, until an administrator publishes their own under Templates.
 * Lines starting "## " are headings and lines starting "- " are list items.
 * {institution}, {system} and {dpo} are filled in when the notice is shown.
 */
export const DEFAULT_PRIVACY_TITLE = "Privacy notice";

export const DEFAULT_PRIVACY_BODY = `{institution} ("the University") is the data controller for personal data processed in the {system}, in line with the Nigeria Data Protection Act 2023 (NDPA).

## What we process
- Identity from your Microsoft 365 account: name, email, directory job title and department.
- Employment records: staff number, department, designation, employment status and dates.
- Salary figures (basic, gross, net), existing loan deductions and obligations.
- Bank details for disbursement. The account number is stored encrypted and only its last four digits are displayed.
- Application, guarantor, approval, repayment and ledger records, supporting documents, messages and notifications.
- Security records: sign-in sessions, IP address and browser, and an audit trail of actions.

## Why, and on what basis
To assess, approve, disburse, service and recover staff loans; to manage guarantees; and to meet financial-control, audit and legal obligations. The bases are the performance of the loan and guarantor agreements you enter into, the University's legal obligations, and its legitimate interest in the integrity of its finances.

## Who can see it
Only staff whose role requires it: Human Resources for verification, the approving authority, the Bursary for disbursement and repayment, and system administrators for configuration. Guarantors see the loan details relevant to their obligation. Every access to documents is logged. Data is not sold or shared outside the University except where required by law.

## How long we keep it
Loan, ledger and audit records are kept for the period set in the University's records-retention schedule for financial records. Operational data (read notifications, expired sessions, delivered email copies) is deleted automatically after the periods configured by the administrators.

## Security
Sign-in is through your institutional Microsoft account. Data is encrypted in transit, and documents and bank details are also encrypted at rest. Access is role-based and checked on the server, and financial records cannot be altered or deleted, only corrected through traceable reversals.

## Your rights
You may access, correct or object to the processing of your data, or lodge a complaint with the Nigeria Data Protection Commission. You can download a copy of your data at any time from My profile by selecting "Download my data". For corrections or other requests, contact the Data Protection Officer at {dpo}.`;

export function fillPrivacy(text: string, v: { institution: string; system: string; dpo: string }) {
  return text.replaceAll("{institution}", v.institution).replaceAll("{system}", v.system).replaceAll("{dpo}", v.dpo);
}
