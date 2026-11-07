import Link from "next/link";
import { getDb } from "@/db";
import { getSetting } from "@/server/settings";
import { getBranding, logoUrl } from "@/server/branding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy notice" };

export default async function Privacy() {
  const db = await getDb();
  const dpo = await getSetting(db, "privacy.dpoEmail");
  const brand = await getBranding(db);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl(brand, "logo")} alt={brand.institutionName} className="h-12 w-auto" />
        <Link href="/dashboard" className="link text-sm">Back to the {brand.systemName}</Link>
      </div>
      <div className="mb-6 rounded-md border border-amber-200 bg-warning-50 px-4 py-3 text-sm text-warning-ink" role="note">
        Draft notice. It must be reviewed and approved by the institution&apos;s Data Protection Officer and Legal Office before go-live.
      </div>
      <article className="space-y-5 text-sm leading-relaxed text-slate-800 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-navy">
        <h1 className="text-2xl font-semibold text-ink">{brand.systemName}: privacy notice</h1>
        <p>{brand.institutionName} (&quot;the University&quot;) is the data controller for personal data processed in the {brand.systemName}, in line with the Nigeria Data Protection Act 2023 (NDPA).</p>
        <h2>What we process</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Identity from your Microsoft 365 account: name, email, directory job title and department.</li>
          <li>Employment records: staff number, department, designation, employment status and dates.</li>
          <li>Salary figures (basic, gross, net), existing loan deductions and obligations.</li>
          <li>Bank details for disbursement. The account number is stored encrypted and only its last four digits are displayed.</li>
          <li>Application, guarantor, approval, repayment and ledger records, supporting documents, messages and notifications.</li>
          <li>Security records: sign-in sessions, IP address and browser, and an audit trail of actions.</li>
        </ul>
        <h2>Why, and on what basis</h2>
        <p>To assess, approve, disburse, service and recover staff loans; to manage guarantees; and to meet financial-control, audit and legal obligations. The bases are the performance of the loan and guarantor agreements you enter into, the University&apos;s legal obligations, and its legitimate interest in the integrity of its finances.</p>
        <h2>Who can see it</h2>
        <p>Only staff whose role requires it: Human Resources for verification, the approving authority, the Bursary for disbursement and repayment, and system administrators for configuration. Guarantors see the loan details relevant to their obligation. Every access to documents is logged. Data is not sold or shared outside the University except where required by law.</p>
        <h2>How long we keep it</h2>
        <p>Loan, ledger and audit records are kept for the period set in the University&apos;s records-retention schedule for financial records. Operational data (read notifications, expired sessions, delivered email copies) is deleted automatically after the periods configured by the administrators.</p>
        <h2>Security</h2>
        <p>Sign-in is through your institutional Microsoft account. Data is encrypted in transit, and documents and bank details are also encrypted at rest. Access is role-based and checked on the server, and financial records cannot be altered or deleted, only corrected through traceable reversals.</p>
        <h2>Your rights</h2>
        <p>You may access, correct or object to the processing of your data, or lodge a complaint with the Nigeria Data Protection Commission. You can download a copy of your data at any time from <Link href="/profile" className="link">My profile</Link> by selecting &quot;Download my data&quot;. For corrections or other requests, contact the Data Protection Officer at <a className="link" href={`mailto:${dpo}`}>{dpo}</a>.</p>
      </article>
    </main>
  );
}
