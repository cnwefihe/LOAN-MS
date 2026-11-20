/**
 * The loan assistant: guides for what each person may do, their own next steps, answers to questions,
 * and support requests to ICT. Everything here reads only the signed-in person's own records, and guides
 * are filtered by their permissions, so nobody learns about work or people they have no part in.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { applicationGuarantors, emailOutbox, loanAccounts, loanApplications, loanProducts, repaymentSchedules, scheduleInstalments, staffPayslips } from "@/db/schema";
import { guidesFor, searchGuides, type Guide } from "@/lib/assistant/guides";
import { formatDate } from "@/lib/finance/dates";
import { dec } from "@/lib/finance/money";
import { productSummary, whoMayApply } from "@/lib/finance/product-summary";
import { can, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";
import { getSetting } from "../settings";
import { approvalStageName, loadWording } from "../wording";
import { departmentHeadOf, departmentsHeadedBy } from "./staff";
import { isInstitutionalEmail } from "./identity";
import { listOpenProducts } from "./policies";

export interface NextStep { text: string; href?: string; tone?: "info" | "warning" | "success" }
export interface Answer { lines: string[]; links: { label: string; href: string }[]; guides: string[] }

const naira = (v: string | number) => `₦${Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The guides this person may read. */
export async function myGuides(db: Executor, actor: Actor): Promise<Guide[]> {
  const approver = (await departmentsHeadedBy(db, actor.userId)).length > 0;
  return guidesFor(actor.permissions, { approver, admin: actor.roles.includes("SUPER_ADMIN") });
}

/** Where each of this person's applications is, in words, with what happens next. */
async function applicationSteps(db: Executor, actor: Actor): Promise<NextStep[]> {
  if (!can(actor, "application.view_own")) return [];
  const apps = await db.select({ a: loanApplications, product: loanProducts.name }).from(loanApplications)
    .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .where(and(eq(loanApplications.applicantId, actor.userId), inArray(loanApplications.status, ["draft", "returned", "pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "approved"])))
    .orderBy(desc(loanApplications.updatedAt)).limit(3);
  if (!apps.length) return [];
  const w = await loadWording(db);
  const head = await departmentHeadOf(db, actor.userId);
  const out: NextStep[] = [];
  for (const { a, product } of apps) {
    const name = `${product} ${a.reference}`;
    const href = `/applications/${a.id}`;
    if (a.status === "draft") out.push({ text: `${name} is a draft. Finish it and submit when ready.`, href: `/applications/${a.id}/edit`, tone: "warning" });
    else if (a.status === "returned") out.push({ text: `${name} was returned to you. Read the note, make the change and submit again.`, href, tone: "warning" });
    else if (a.status === "pending_guarantor") {
      const gs = await db.select({ status: applicationGuarantors.status }).from(applicationGuarantors).where(eq(applicationGuarantors.applicationId, a.id));
      const live = gs.filter((g) => !["withdrawn", "replaced"].includes(g.status));
      const accepted = live.filter((g) => g.status === "accepted").length;
      const declined = live.filter((g) => g.status === "declined").length;
      out.push({ text: declined ? `${name}: a guarantor declined. Choose someone else to continue.` : `${name} is waiting for your guarantors (${accepted} of ${live.length} accepted).`, href, tone: declined ? "warning" : "info" });
    } else if (a.status === "pending_hr") out.push({ text: `${name} is with ${w.stage.hr}.`, href });
    else if (a.status === "pending_bursary") out.push({ text: `${name} is at ${w.stage.bursary}.`, href });
    else if (a.status === "pending_approval") out.push({ text: `${name} is at ${approvalStageName(w, a.currentApprovalLevel ?? 1, head?.approverTitle)}.`, href });
    else if (a.status === "approved") {
      const [loan] = await db.select({ status: loanAccounts.status }).from(loanAccounts).where(eq(loanAccounts.applicationId, a.id));
      if (loan?.status === "pending_disbursement") out.push({ text: `${name} is approved and waiting to be paid by Accounts Payable.`, href, tone: "success" });
    }
  }
  return out;
}

/** This person's next steps: their applications, guarantees, repayments and the work waiting for them. */
export async function nextSteps(db: Executor, actor: Actor, work: { label: string; href: string; count: number }[] = []): Promise<NextStep[]> {
  const steps = await applicationSteps(db, actor);
  if (can(actor, "guarantee.view_own")) {
    const asked = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors)
      .where(and(eq(applicationGuarantors.guarantorId, actor.userId), inArray(applicationGuarantors.status, ["pending", "clarification_requested"])));
    if (asked.length) steps.push({ text: `${asked.length} ${asked.length === 1 ? "colleague is" : "colleagues are"} waiting for you to accept or decline a guarantee.`, href: "/guarantor", tone: "warning" });
  }
  if (can(actor, "loan.view_own")) {
    const [due] = await db.select({ i: scheduleInstalments }).from(scheduleInstalments)
      .innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
      .innerJoin(loanAccounts, eq(loanAccounts.id, scheduleInstalments.loanAccountId))
      .where(and(eq(loanAccounts.borrowerId, actor.userId), eq(repaymentSchedules.isCurrent, true), inArray(scheduleInstalments.status, ["pending", "partial", "overdue"])))
      .orderBy(asc(scheduleInstalments.dueDate)).limit(1);
    if (due) {
      const left = dec(due.i.totalDue).minus(due.i.principalPaid).minus(due.i.interestPaid);
      steps.push({ text: `${due.i.status === "overdue" ? "Overdue" : "Next"} deduction: ${naira(left.toFixed(2))} ${due.i.status === "overdue" ? "was due" : "due"} on ${formatDate(due.i.dueDate)}.`, href: "/loans", tone: due.i.status === "overdue" ? "warning" : "info" });
    }
  }
  for (const w of work.filter((x) => x.count > 0)) steps.push({ text: `${w.count} waiting in ${w.label}.`, href: w.href, tone: "info" });
  return steps;
}

const has = (q: string, ...re: RegExp[]) => re.some((r) => r.test(q));

/** An answer to a question in the person's own words, from their own records, the current terms and the guides. */
export async function answerQuestion(db: Executor, actor: Actor, question: string): Promise<Answer> {
  const q = question.toLowerCase().trim().slice(0, 300);
  const guides = await myGuides(db, actor);
  const out: Answer = { lines: [], links: [], guides: [] };
  if (!q) return out;

  // Their own applications.
  if (has(q, /\b(status|where|track|stage|progress|pending|waiting|how long|stuck)\b/) && has(q, /appl|request|loan|my/)) {
    const steps = await applicationSteps(db, actor);
    out.lines.push(...(steps.length ? steps.map((s) => s.text) : ["You have no application in progress."]));
    if (can(actor, "application.view_own")) out.links.push({ label: "My applications", href: "/applications" });
  }
  // Their own balance and repayments.
  if (can(actor, "loan.view_own") && has(q, /\b(owe|balance|outstanding|next (payment|deduction|repayment)|how much (is )?left|due)\b/)) {
    const loans = await db.select().from(loanAccounts).where(and(eq(loanAccounts.borrowerId, actor.userId), inArray(loanAccounts.status, ["active", "overdue", "defaulted"])));
    if (!loans.length) out.lines.push("You have no loan being repaid.");
    else {
      const total = loans.reduce((n, l) => n.plus(l.principalOutstanding).plus(l.interestOutstanding), dec(0));
      out.lines.push(`You owe ${naira(total.toFixed(2))} on ${loans.length} ${loans.length === 1 ? "loan" : "loans"}.`);
      const next = (await nextSteps(db, actor)).find((s) => s.href === "/loans");
      if (next) out.lines.push(next.text);
    }
    out.links.push({ label: "My loans", href: "/loans" });
  }
  // Their own guarantees.
  if (can(actor, "guarantee.view_own") && has(q, /guarant/) && has(q, /\b(request|asked|my|pending|waiting|accept|decline)\b/)) {
    const asked = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors)
      .where(and(eq(applicationGuarantors.guarantorId, actor.userId), inArray(applicationGuarantors.status, ["pending", "clarification_requested"])));
    out.lines.push(asked.length ? `${asked.length} guarantee ${asked.length === 1 ? "request is" : "requests are"} waiting for your answer.` : "No one is waiting for you to guarantee a loan.");
    out.links.push({ label: "My guarantees", href: "/guarantor" });
  }
  // Their payslip.
  if (can(actor, "application.create") && has(q, /payslip/) && has(q, /\b(my|last|latest|uploaded|which)\b/)) {
    const [slip] = await db.select({ period: staffPayslips.period, at: staffPayslips.createdAt }).from(staffPayslips).where(eq(staffPayslips.userId, actor.userId)).orderBy(desc(staffPayslips.createdAt)).limit(1);
    out.lines.push(slip ? `Your latest payslip was uploaded on ${formatDate(slip.at)}${slip.period ? ` (for ${slip.period})` : ""}.` : "You have not uploaded a payslip yet. Upload it under Eligibility or when you apply.");
  }
  // The current terms of each product.
  if (can(actor, "application.create") && has(q, /\b(interest|rate|tenor|months|years|guarantors? (needed|required)|how many guarantors|service|who (can|may) apply|qualify|products?|types? of loan|advance)\b/)) {
    const products = await listOpenProducts(db);
    for (const p of products.slice(0, 6)) out.lines.push(`${p.name}: ${productSummary(p.params)} Who may apply: ${whoMayApply(p.params)}`);
    if (!products.length) out.lines.push("No product is open for applications at the moment.");
    out.links.push({ label: "See the products", href: "/products" });
  }

  const found = searchGuides(guides, q, out.lines.length ? 2 : 3);
  out.guides = found.map((g) => g.id);
  if (!out.lines.length && !found.length) {
    out.lines.push("I could not find an answer to that. Try other words, browse the guides below, or send a request to ICT support.");
  }
  return out;
}

export const SIGN_IN_CATEGORIES = ["Security check (slider)", "Signing in with Microsoft", "Two-step verification code", "Setting up two-step verification", "Something else"] as const;

/**
 * A request to ICT support from someone who cannot sign in. They give their name and work email; the copy is
 * sent only to a work address, so the form cannot be used to send email to anyone else. Limited per device
 * and per address by the caller.
 */
export async function submitSignInSupportRequest(db: Executor, input: { name: string; email: string; category: string; subject: string; message: string; page: string; ip: string }) {
  const to = await getSetting(db, "org.ictEmail");
  if (!to) throw new DomainError("ICT support has no email address yet. Please contact ICT directly.");
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  const email = input.email.trim().toLowerCase().slice(0, 254);
  const category = (SIGN_IN_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "Something else";
  const subject = input.subject.replace(/\s+/g, " ").trim().slice(0, 120);
  const message = input.message.trim().slice(0, 4000);
  const page = /^\/[\w\-/?=&.%]*$/.test(input.page) ? input.page.slice(0, 200) : "";
  if (name.length < 2) throw new DomainError("Enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("Enter your email address.");
  if (!isInstitutionalEmail(email)) throw new DomainError("Use the email address you sign in with, so ICT can find your account and reply.");
  if (subject.length < 3) throw new DomainError("Give your request a short subject.");
  if (message.length < 10) throw new DomainError("Describe the problem in a few words so ICT can help.");
  const ref = `SR-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const system = await getSetting(db, "org.systemName");
  await db.insert(emailOutbox).values({
    toAddress: to, subject: `[${ref}] ${category}: ${subject}`,
    body: `A support request from the ${system} sign-in page (the person was not signed in).

Reference: ${ref}
From: ${name} (${email})
Topic: ${category}
Page: ${page || "Not given"}

${message}

Reply to ${email} to answer. Check the address belongs to the person before changing anything on their account.`,
  });
  await db.insert(emailOutbox).values({
    toAddress: email, subject: `We received your request ${ref}`,
    body: `Dear ${name.split(" ")[0]},

Thank you. ICT support has received your request about signing in and will reply to this email address.

Reference: ${ref}
Subject: ${subject}

If you did not send this request, you can ignore this email.`,
  });
  await audit(db, null, { action: "support.request_sent", entityType: "support_request", entityId: ref, summary: `Sign-in support request ${ref}: ${category} from ${email}`, after: { ip: input.ip } });
  return ref;
}

const CATEGORIES = ["Signing in", "Payslip or eligibility", "My application", "My loan or repayments", "Guarantees", "My work queue", "Something else"] as const;
export const SUPPORT_CATEGORIES = CATEGORIES;

/** Whether ICT support has an email address set (Branding > Organisation). */
export async function supportAvailable(db: Executor) {
  return !!(await getSetting(db, "org.ictEmail"));
}

/**
 * A request to ICT support, emailed to the ICT support address with who sent it and from which page, and a
 * copy to the sender. Only the sender's own name, email and roles are included.
 */
export async function submitSupportRequest(db: Executor, actor: Actor, input: { category: string; subject: string; message: string; page: string; roles: string[] }) {
  const to = await getSetting(db, "org.ictEmail");
  if (!to) throw new DomainError("ICT support has no email address yet. Please contact ICT directly.");
  const category = (CATEGORIES as readonly string[]).includes(input.category) ? input.category : "Something else";
  const subject = input.subject.replace(/\s+/g, " ").trim().slice(0, 120);
  const message = input.message.trim().slice(0, 4000);
  const page = /^\/[\w\-/?=&.%]*$/.test(input.page) ? input.page.slice(0, 200) : "";
  if (subject.length < 3) throw new DomainError("Give your request a short subject.");
  if (message.length < 10) throw new DomainError("Describe the problem in a few words so ICT can help.");
  const ref = `SR-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const system = await getSetting(db, "org.systemName");
  await db.insert(emailOutbox).values({
    toAddress: to, subject: `[${ref}] ${category}: ${subject}`,
    body: `A support request from the ${system}.

Reference: ${ref}
From: ${actor.displayName} (${actor.email})
Roles: ${input.roles.join(", ") || "Staff"}
Topic: ${category}
Page: ${page || "Not given"}

${message}

Reply to ${actor.email} to answer.`,
  });
  await db.insert(emailOutbox).values({
    toAddress: actor.email, subject: `We received your request ${ref}`,
    body: `Dear ${actor.displayName.split(" ")[0]},

Thank you. ICT support has received your request and will reply to this email address.

Reference: ${ref}
Subject: ${subject}

Your message:
${message}`,
  });
  await audit(db, actor, { action: "support.request_sent", entityType: "support_request", entityId: ref, summary: `Support request ${ref}: ${category}` });
  return ref;
}
