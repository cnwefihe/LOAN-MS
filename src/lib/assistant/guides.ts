/**
 * The loan assistant's guides. Each guide says who may read it: everyone (self-service), guarantors, or
 * people holding a permission. Guides are filtered on the server, so nobody is sent a guide for work they
 * cannot do. Administrators see every guide.
 */
import type { Permission } from "@/lib/auth/permissions";

export type Audience = "everyone" | "approver" | Permission;

export interface Guide {
  id: string;
  /** Heading under which the guide is listed. */
  area: "Getting started" | "Applying" | "Your loan" | "Guarantors" | "Human Resources" | "Bursary" | "Approvals" | "Accounts Payable" | "Payroll" | "Finance" | "Reports" | "Administration";
  title: string;
  /** Any one of these lets the person read the guide. */
  audience: Audience[];
  /** Pages the guide is about ("/loans/*" matches any loan). Shown first on those pages. */
  pages: string[];
  /** Words people might use when asking about it. */
  keywords: string[];
  summary: string;
  steps: string[];
  links?: { label: string; href: string }[];
}

const EVERYONE: Audience[] = ["everyone"];

export const GUIDES: Guide[] = [
  // ───────────── Getting started (everyone) ─────────────
  {
    id: "dashboard", area: "Getting started", title: "Your dashboard", audience: EVERYONE, pages: ["/dashboard", "/home"],
    keywords: ["dashboard", "home", "overview", "start", "main page", "balance", "summary"],
    summary: "The dashboard shows your loans, applications, guarantor requests and latest notifications in one place.",
    steps: [
      "Outstanding balance is what you still owe on all your loans. Select it to open your loans.",
      "Next repayment shows the amount and date of your next salary deduction.",
      "Applications in progress counts applications still being processed. Select it to see where each one is.",
      "Guarantor requests shows colleagues waiting for you to accept or decline guaranteeing their loan.",
      "If you have a work role, the items waiting for you appear first, with a count beside each menu item.",
    ],
    links: [{ label: "Open my loans", href: "/loans" }, { label: "My applications", href: "/applications" }],
  },
  {
    id: "menu", area: "Getting started", title: "Finding your way around", audience: EVERYONE, pages: ["/dashboard", "/home"],
    keywords: ["menu", "navigate", "where", "find", "sidebar", "page", "lost"],
    summary: "The menu on the left (or under the menu button on a phone) lists only what you can use.",
    steps: [
      "Self-service holds your own dashboard, applications, loans, guarantees and profile.",
      "If you have a work role, its section (for example Human Resources or Bursary) appears with a count of items waiting.",
      "The bell at the top shows your notifications. Select one to go straight to the item.",
      "Use Back links at the top of a page to return to the list you came from, on the same page of results.",
    ],
  },
  {
    id: "signin", area: "Getting started", title: "Signing in and security", audience: EVERYONE, pages: ["/profile"],
    keywords: ["sign in", "login", "log in", "slider", "verification", "code", "authenticator", "locked", "two-step", "otp", "signed out", "timeout"],
    summary: "Sign in with your work Microsoft account after a short security check.",
    steps: [
      "Drag the slider so the piece fits into its place. If it does not fit, a new picture appears; try again.",
      "After several failed attempts the device is locked for a short time. Wait for the countdown, then try again.",
      "Sign in with your work Microsoft account, then enter the six-digit code from your authenticator app if asked.",
      "You are signed out after a period without activity, to protect your information. Sign in again to continue.",
    ],
  },
  {
    id: "profile", area: "Getting started", title: "My profile and details", audience: EVERYONE, pages: ["/profile"],
    keywords: ["profile", "details", "employee code", "pay grade", "employment date", "confirmed", "name", "change my details", "wrong details"],
    summary: "Your employee code, pay grade, employment date and confirmation are recorded by Human Resources. You only check your name.",
    steps: [
      "Open My profile from the menu.",
      "Check your name as printed on your payslip and save it if it differs.",
      "If your employee code, pay grade or employment date is wrong, contact Human Resources. They update it, and your profile follows.",
      "Download my data gives you a PDF of every record held about you.",
    ],
    links: [{ label: "Open My profile", href: "/profile" }],
  },
  {
    id: "notifications", area: "Getting started", title: "Notifications and emails", audience: EVERYONE, pages: ["/notifications"],
    keywords: ["notification", "email", "alert", "message", "bell", "reminder"],
    summary: "You are told at each step that concerns you, in the app and by email.",
    steps: [
      "Select the bell at the top to see recent notifications.",
      "Selecting a notification takes you straight to the application, loan or request it is about.",
      "Emails are sent to your work address for the same events.",
    ],
    links: [{ label: "All notifications", href: "/notifications" }],
  },
  {
    id: "install", area: "Getting started", title: "Using it on your phone or laptop", audience: EVERYONE, pages: [],
    keywords: ["install", "phone", "mobile", "app", "laptop", "shortcut", "home screen"],
    summary: "The system works in any browser and can be installed like an app.",
    steps: [
      "On a phone, open the site in Chrome or Safari, then choose Add to Home Screen (or Install app).",
      "On a laptop in Chrome or Edge, select the install icon in the address bar.",
      "Sign in as usual. Everything works the same as in the browser.",
    ],
  },

  // ───────────── Applying (everyone who may apply) ─────────────
  {
    id: "apply", area: "Applying", title: "How to apply for a loan", audience: ["application.create"], pages: ["/applications/new", "/applications", "/products", "/dashboard"],
    keywords: ["apply", "application", "new loan", "request a loan", "borrow", "how do i apply", "start"],
    summary: "Apply in five steps. Your details come from Human Resources, so there is little to type.",
    steps: [
      "Download your latest payslip as a PDF.",
      "Open Products and select Apply on the product you need, or select New application under Applications.",
      "Upload your payslip. The system reads it and shows at once how much you can borrow and the monthly deduction.",
      "Enter the amount, the number of months and the purpose, then choose your guarantors if the product needs them.",
      "Read and accept the terms, then submit. You can save a draft and finish later.",
    ],
    links: [{ label: "Apply now", href: "/applications/new" }, { label: "See the products", href: "/products" }],
  },
  {
    id: "eligibility", area: "Applying", title: "How much can I borrow?", audience: ["application.create"], pages: ["/eligibility", "/applications/new"],
    keywords: ["how much", "eligible", "eligibility", "limit", "maximum", "afford", "deduction limit", "calculator", "qualify", "can i borrow"],
    summary: "What you can borrow is worked out from your latest payslip and the product's terms.",
    steps: [
      "Open Eligibility (or start an application) and upload your latest payslip.",
      "The system checks your length of service and employment status against the product.",
      "It adds your existing deductions to the new monthly deduction and checks they stay within the limit allowed on your pay.",
      "It then shows the most you can borrow and the monthly deduction for the months you choose.",
      "If something stops you applying, the reason is shown, for example a payslip from an older month.",
    ],
    links: [{ label: "Check my eligibility", href: "/eligibility" }],
  },
  {
    id: "payslip", area: "Applying", title: "Payslip problems", audience: ["application.create"], pages: ["/eligibility", "/applications/new"],
    keywords: ["payslip", "pdf", "upload", "not read", "cannot read", "wrong month", "mac", "scanned", "photo"],
    summary: "Upload the payslip PDF exactly as downloaded. Photos and scans cannot be read.",
    steps: [
      "Download the payslip PDF from the payroll portal. Do not print and scan it, or take a photo.",
      "Use your most recent payslip. An older month is refused.",
      "Payslips saved on a Mac or Windows computer are both read.",
      "If the name, employee code or pay grade does not match your profile, contact Human Resources to correct your record.",
      "If it still cannot be read, send a request to ICT support from this assistant.",
    ],
  },
  {
    id: "guarantors-choose", area: "Applying", title: "Choosing guarantors", audience: ["application.create"], pages: ["/applications/new", "/applications/*"],
    keywords: ["guarantor", "choose guarantor", "who can guarantee", "declined", "replace guarantor", "guarantors needed"],
    summary: "Choose colleagues who meet the loan policy. Each is asked to accept by email.",
    steps: [
      "In the application, choose the number of guarantors the product asks for.",
      "Any active member of staff who meets the policy (for example length of service) can be chosen.",
      "Each guarantor receives an email and must accept before Human Resources can verify your application.",
      "If a guarantor declines, you are told and can choose someone else.",
    ],
  },
  {
    id: "track", area: "Applying", title: "Where is my application?", audience: ["application.view_own"], pages: ["/applications", "/applications/*", "/dashboard"],
    keywords: ["status", "where is", "track", "stage", "progress", "pending", "waiting", "how long", "my application"],
    summary: "Each application moves through guarantors, Human Resources, the Bursary, approvals and payment.",
    steps: [
      "Open My applications and select the reference to see a tracker of each stage.",
      "Guarantors accept first, then Human Resources verifies your employment and pay.",
      "The Bursary checks your loan history, deduction limit and the fund, then the approvers decide in turn.",
      "Once the Bursar approves, Accounts Payable pays the loan into your account and the loan starts.",
      "You are notified at each step. The assistant also shows your current stage above.",
    ],
    links: [{ label: "My applications", href: "/applications" }],
  },
  {
    id: "returned", area: "Applying", title: "My application was returned", audience: ["application.create"], pages: ["/applications/*"],
    keywords: ["returned", "sent back", "correction", "fix", "change application", "edit application", "resubmit"],
    summary: "A returned application needs a change from you before it can continue.",
    steps: [
      "Open the application from My applications. The note explains what to change.",
      "Select Edit, make the change and submit again.",
      "It goes back to the stage that returned it.",
    ],
  },
  {
    id: "declined", area: "Applying", title: "If an application is declined or you change your mind", audience: ["application.create"], pages: ["/applications/*"],
    keywords: ["declined", "rejected", "cancel", "withdraw", "delete draft"],
    summary: "You can withdraw an application before it is decided; a declined application shows the reason.",
    steps: [
      "To withdraw, open the application and select Cancel application.",
      "A declined application shows who declined it and why.",
      "You can apply again once the reason no longer applies.",
    ],
  },

  // ───────────── Your loan ─────────────
  {
    id: "repay", area: "Your loan", title: "How repayment works", audience: ["loan.view_own"], pages: ["/loans", "/loans/*", "/dashboard"],
    keywords: ["repay", "repayment", "deduction", "salary", "monthly", "instalment", "how do i pay", "next payment", "due", "schedule"],
    summary: "Loans are repaid by monthly deduction from your salary. You do not need to pay anything yourself.",
    steps: [
      "After the loan is paid out, deductions start from the salary of the following month (or after any grace period).",
      "Payroll confirms the first deduction. From then on each instalment is recorded automatically on its due date.",
      "Open My loans and select the loan to see the schedule, what you have paid and what is left.",
      "Select Statement under My loans to download a statement at any time.",
    ],
    links: [{ label: "My loans", href: "/loans" }],
  },
  {
    id: "report-deduction", area: "Your loan", title: "Reporting a repayment", audience: ["repayment.claim"], pages: ["/loans/*"],
    keywords: ["report deduction", "deducted", "payslip shows", "not recorded", "missing payment", "claim"],
    summary: "If a repayment appears on your payslip but not on your loan, report it from the loan page. Once Payroll confirms your first deduction, later ones are recorded automatically.",
    steps: [
      "Open the loan from My loans.",
      "Open the Report a repayment tab, enter the month and amount, and attach the payslip or receipt that shows it.",
      "Payroll checks it and records the payment.",
    ],
  },
  {
    id: "repay-early", area: "Your loan", title: "Repaying early", audience: ["repayment.claim"], pages: ["/loans/*", "/loans/*/repay-early"],
    keywords: ["early", "pay off", "settle", "clear my loan", "repay early", "full payment", "balance", "lump sum", "account number"],
    summary: "Pay the whole balance into your school's account, then send the receipt. Interest is charged only up to the day you pay.",
    steps: [
      "Open the loan and select Repay early. The amount to pay today is shown, with the interest you save.",
      "Pay that amount into the account shown. It is your own school's account.",
      "Upload the payment receipt and send the request.",
      "Payroll checks the payment and closes the loan. You are notified when it is closed.",
    ],
  },
  {
    id: "restructure", area: "Your loan", title: "Changing your repayment period", audience: ["restructure.request"], pages: ["/loans/*"],
    keywords: ["restructure", "extend", "longer", "reduce deduction", "change months", "difficulty"],
    summary: "If repayments are hard, you can ask to spread the balance over a different period.",
    steps: [
      "Open the loan and select the Restructuring tab (shown when the product allows it).",
      "Give the number of months and the reason.",
      "The Bursar reviews the request and you are told the decision.",
    ],
  },

  // ───────────── Guarantors ─────────────
  {
    id: "guarantee-respond", area: "Guarantors", title: "Responding to a guarantor request", audience: ["guarantee.view_own"], pages: ["/guarantor", "/guarantor/requests/*"],
    keywords: ["guarantor request", "guarantee", "accept", "decline", "stand surety", "asked to guarantee", "clarification"],
    summary: "A colleague has asked you to guarantee their loan. Read the details, then accept or decline.",
    steps: [
      "Open Guarantees from the menu, or select the link in the email.",
      "Read the amount, the repayment period and your share if the borrower does not repay.",
      "To accept, confirm the statements, type your name and upload your payslip if asked.",
      "To decline, select Decline. The applicant can then choose someone else.",
      "If something is unclear, ask the applicant a question before deciding.",
    ],
    links: [{ label: "My guarantees", href: "/guarantor" }],
  },
  {
    // Anyone who may apply can be chosen as a guarantor, so everyone who applies can read what it means.
    id: "guarantee-obligation", area: "Guarantors", title: "What being a guarantor means", audience: ["guarantee.view_own", "application.create"], pages: ["/guarantor"],
    keywords: ["obligation", "liable", "risk", "what happens", "default", "borrower does not pay", "guarantor share"],
    summary: "You may be asked to repay your share if the borrower stops repaying.",
    steps: [
      "Your share of the loan is shown before you accept.",
      "The guarantee stays active until the loan is fully repaid.",
      "What you could be asked to repay may count against your own deduction limit when you borrow.",
      "My guarantees lists each guarantee and whether it is still active.",
    ],
  },

  // ───────────── Human Resources ─────────────
  {
    id: "hr-verify", area: "Human Resources", title: "Verifying an application", audience: ["hr.queue.view"], pages: ["/hr", "/hr/applications", "/hr/applications/*"],
    keywords: ["verify", "verification", "hr queue", "employment", "salary check", "approve hr", "hr review"],
    summary: "Check each applicant's employment and pay, and each guarantor's capacity, before the Bursary.",
    steps: [
      "Open Human Resources > Verification. The count shows applications waiting.",
      "Select an application and check employment, staff status, department and the payslip details.",
      "Assess each guarantor as capable or not.",
      "Verify to send it to the Bursary, return it to the applicant with a note, or decline it with a reason.",
    ],
    links: [{ label: "Verification queue", href: "/hr/applications" }],
  },
  {
    id: "hr-staff", area: "Human Resources", title: "Staff records", audience: ["hr.staff.view"], pages: ["/hr/staff", "/hr/staff/*"],
    keywords: ["staff records", "employee", "update record", "pay grade", "employment date", "staff list"],
    summary: "Look up and correct staff employment details. Changes update the person's profile and the Register.",
    steps: [
      "Open Human Resources > Staff records and search for the person.",
      "Open their record to see employment, pay and loan history.",
      "If you may edit, change the details and give a reason. The latest change from Human Resources or the administrator is what holds.",
    ],
  },
  {
    id: "register", area: "Human Resources", title: "The Register", audience: ["register.view"], pages: ["/admin/register"],
    keywords: ["register", "upload", "employee code", "spreadsheet", "excel", "csv", "bulk", "import staff"],
    summary: "The Register holds every employee's code, pay grade, employment date and confirmation. It fills their profile.",
    steps: [
      "Open Register and enter your six-digit authenticator code. It closes after a period without activity.",
      "To upload, use Excel or CSV with the headings: Employee code, Pay grade, Employment date, Confirmation and, optionally, Email.",
      "Write dates day first (DD/MM/YYYY), or as 02 Mar 2015.",
      "Profiles of staff who have signed in are updated at once; others are filled when they first sign in.",
    ],
    links: [{ label: "Open the Register", href: "/admin/register" }],
  },
  {
    id: "guarantor-list", area: "Human Resources", title: "Guarantors list", audience: ["guarantors.view"], pages: ["/admin/guarantors"],
    keywords: ["guarantors list", "who guaranteed", "active guarantees"],
    summary: "See everyone chosen as a guarantor, for whom, and whether they accepted.",
    steps: ["Open Guarantors.", "Use the tabs to see active guarantees, those awaiting a reply, accepted or declined."],
  },

  // ───────────── Bursary ─────────────
  {
    id: "bursary-review", area: "Bursary", title: "Bursary review", audience: ["bursary.review"], pages: ["/bursary/review", "/bursary/review/*"],
    keywords: ["bursary review", "loan history", "fund", "deduction limit", "clear", "forward"],
    summary: "After Human Resources, check loan history, the deduction limit and the school's fund pool.",
    steps: [
      "Open Bursary > Reviews and select an application.",
      "Check the last loan and when it was repaid (correct it only for loans taken before this system).",
      "Confirm the deductions stay within the limit and funds are available in the school's pool.",
      "Clear it to send it for approval, return it, or decline it with a reason.",
    ],
  },
  {
    id: "reconciliation", area: "Bursary", title: "Reconciliation and deduction schedules", audience: ["accounts.view"], pages: ["/accounts/reconciliation", "/accounts", "/accounts/loans", "/accounts/loans/*"],
    keywords: ["reconciliation", "deduction schedule", "payroll schedule", "filter", "month", "school", "download", "loan accounts", "ledger"],
    summary: "Compare expected deductions with what was received, and download the deduction schedule.",
    steps: [
      "Open Bursary > Reconciliation.",
      "Filter by year, month (or whole year), staff member, school or department.",
      "Downloads follow the filter and list each borrower's school.",
      "Loan accounts lists every loan with its balance and history.",
    ],
  },
  {
    id: "authorise", area: "Bursary", title: "Pending authorisations", audience: ["transaction.approve"], pages: ["/accounts/approvals"],
    keywords: ["authorise", "authorisation", "checker", "approve transaction", "adjustment", "reversal", "refund"],
    summary: "Approve or reject adjustments, refunds and reversals proposed by colleagues.",
    steps: ["Open Pending authorisations.", "Check each transaction and its reason.", "Approve or reject it. You cannot approve your own."],
  },

  // ───────────── Approvals ─────────────
  {
    id: "approve", area: "Approvals", title: "Approving applications", audience: ["approver", "approval.queue.view"], pages: ["/approvals", "/approvals/*"],
    keywords: ["approve", "approval", "decide", "decline", "hod", "line manager", "hr director", "bursar", "sign off"],
    summary: "Applications reach you in turn: Head of Department or Line Manager, then HR Director, then the Bursar.",
    steps: [
      "Open Approvals. The count shows what is waiting for you.",
      "Select an application to see the applicant, amount, repayment and earlier checks.",
      "Approve, decline with a reason, or return it for correction.",
      "After the Bursar approves, Accounts Payable pays out the loan.",
    ],
    links: [{ label: "Open Approvals", href: "/approvals" }],
  },

  // ───────────── Accounts Payable ─────────────
  {
    id: "disburse", area: "Accounts Payable", title: "Paying out a loan", audience: ["disbursement.record"], pages: ["/accounts/disbursements"],
    keywords: ["disburse", "disbursement", "pay out", "payment", "transfer", "bank reference"],
    summary: "Pay approved loans and record the payment. The loan starts on the payment date.",
    steps: [
      "Open Disbursements. The count shows loans waiting to be paid.",
      "Pay the amount to the borrower's account.",
      "Record the payment date and bank reference, and attach evidence if available.",
    ],
  },

  // ───────────── Payroll ─────────────
  {
    id: "payroll-confirm", area: "Payroll", title: "Confirming deductions", audience: ["repayment.confirm"], pages: ["/accounts/repayments", "/payroll"],
    keywords: ["confirm deduction", "first deduction", "repayments", "payroll", "deduction reported", "record repayment"],
    summary: "Confirm the first salary deduction on each loan; later ones are recorded automatically.",
    steps: [
      "Open Payroll > Repayments.",
      "Check each reported or due deduction against the payroll.",
      "Confirm the first deduction with its value date. Later instalments are then recorded on their due dates.",
    ],
  },
  {
    id: "payroll-early", area: "Payroll", title: "Early repayment requests", audience: ["payroll.view"], pages: ["/payroll/early-repayments", "/payroll/early-repayments/*"],
    keywords: ["early repayment", "settlement", "close loan", "receipt", "paid off"],
    summary: "Check the receipt for a loan repaid in full early, then close the loan.",
    steps: [
      "Open Payroll > Early repayments.",
      "Check the receipt against the school's account and the amount due.",
      "If you may close loans, confirm with your six-digit code to close it.",
    ],
  },

  // ───────────── Finance ─────────────
  {
    id: "fund", area: "Finance", title: "School fund pools", audience: ["fund.view"], pages: ["/finance"],
    keywords: ["fund", "pool", "budget", "school fund", "available funds"],
    summary: "Each school has a yearly pool for staff loans. Paying out a loan reduces what is left.",
    steps: ["Open Finance to see each school's pool and what is left.", "If you may set pools, enter each school's amount for the year."],
  },

  // ───────────── Reports ─────────────
  {
    id: "reports", area: "Reports", title: "Reports", audience: ["reports.view"], pages: ["/reports"],
    keywords: ["report", "export", "excel", "pdf", "portfolio", "register", "download"],
    summary: "Portfolio reports, period registers and the deduction schedule.",
    steps: ["Open Reports.", "Choose the report and the period.", "Download as Excel, CSV or PDF if you may export."],
  },

  // ───────────── Administration ─────────────
  {
    id: "admin-users", area: "Administration", title: "Users and roles", audience: ["admin.users.manage", "admin.roles.manage"], pages: ["/admin/users", "/admin/users/*", "/admin/roles", "/admin/roles/*"],
    keywords: ["user", "add user", "role", "permission", "give access", "remove access", "deactivate"],
    summary: "Add staff, give roles, and choose exactly what each role can do.",
    steps: [
      "Users: add staff one at a time or many at once, and give or remove roles.",
      "Roles: open a role, then the Permissions tab, and switch each permission on or off.",
      "Every feature has its own permission, so you can give any task to any role.",
    ],
  },
  {
    id: "admin-products", area: "Administration", title: "Products and terms", audience: ["admin.policy.manage", "admin.policy.approve"], pages: ["/admin/products", "/admin/products/*"],
    keywords: ["product", "terms", "policy", "interest rate", "tenor", "guarantors required", "minimum service"],
    summary: "Set each product's terms. Descriptions shown to staff are written from the terms.",
    steps: ["Open Products and select one.", "Change the terms as a draft.", "Approve the new version to make it active."],
  },
  {
    id: "admin-settings", area: "Administration", title: "Settings, branding and contacts", audience: ["admin.settings.manage", "admin.branding.manage", "settings.security", "settings.lending", "settings.school_accounts"], pages: ["/admin/settings", "/admin/branding"],
    keywords: ["settings", "security settings", "school accounts", "branding", "logo", "contact email", "ict email", "reminders"],
    summary: "Settings shows the sections you may change; Branding holds names, logos and contact emails.",
    steps: [
      "Settings > School accounts: each school's account for early repayments.",
      "Settings > Security: sign-out times, the security check and when the Register closes.",
      "Branding > Organisation: the Bursary, Human Resources and ICT support emails shown to staff.",
    ],
  },
  {
    id: "admin-activity", area: "Administration", title: "Activity log and emails", audience: ["admin.audit.view"], pages: ["/admin/audit", "/admin/audit/*", "/admin/outbox"],
    keywords: ["audit", "activity", "log", "who did", "emails sent", "outbox"],
    summary: "See who did what and when, and every email the system has sent.",
    steps: ["Activity lists every action with the person, time and details.", "Emails shows each message and whether it was delivered."],
  },
];

/** The guides a person may read: by permission, by heading a department, or everything for administrators. */
export function guidesFor(permissions: ReadonlySet<Permission>, opts: { approver: boolean; admin: boolean }): Guide[] {
  return GUIDES.filter((g) => opts.admin || g.audience.some((a) => a === "everyone" || (a === "approver" ? opts.approver : permissions.has(a))));
}

/** Whether a guide is about the page at `path` ("/loans/*" matches "/loans/123"). */
export function guideMatchesPage(g: Guide, path: string): boolean {
  const parts = path.split(/[?#]/)[0].split("/").filter(Boolean);
  return g.pages.some((p) => {
    const want = p.split("/").filter(Boolean);
    return want.length === parts.length && want.every((w, i) => w === "*" || w === parts[i]);
  });
}

const STOP = new Set(["a", "an", "the", "i", "my", "me", "to", "do", "is", "it", "of", "for", "on", "in", "how", "can", "what", "where", "when", "why", "and", "or", "be", "am", "are", "with", "this", "that", "please", "help"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));

/** Guides ranked by how well they answer a question: phrases first, then words in keywords, title and text. */
export function searchGuides(guides: Guide[], question: string, limit = 3): Guide[] {
  const q = question.toLowerCase();
  const qw = words(question);
  if (!qw.length) return [];
  const scored = guides.map((g) => {
    let score = 0;
    for (const k of g.keywords) if (q.includes(k)) score += k.includes(" ") ? 6 : 4;
    const title = words(g.title), keys = new Set(g.keywords.flatMap(words)), text = new Set(words(`${g.summary} ${g.steps.join(" ")}`));
    for (const w of qw) {
      const stem = w.replace(/(ing|ed|es|s)$/, "");
      if (title.some((t) => t.startsWith(stem))) score += 3;
      if ([...keys].some((k) => k.startsWith(stem))) score += 2;
      if ([...text].some((t) => t.startsWith(stem))) score += 1;
    }
    return { g, score };
  });
  return scored.filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.g);
}
