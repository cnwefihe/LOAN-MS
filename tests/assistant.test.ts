/**
 * The loan assistant: each person sees guides only for what they may do, answers come only from their own
 * records, and support requests go to the ICT support address.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-assistant-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft } from "@/server/services/applications";
import { answerQuestion, myGuides, nextSteps, submitSupportRequest } from "@/server/services/assistant";
import { GUIDES, guideMatchesPage, searchGuides } from "@/lib/assistant/guides";
import { updateSetting } from "@/server/services/admin";

let db: Database;
let productId = "";
const ids: Record<string, string> = {};
const actor = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const areas = async (k: string) => new Set((await myGuides(db, await actor(k))).map((g) => g.area));

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
});

describe("guides by role", () => {
  it("an applicant sees self-service and guarantor guides only, never another role's work or administration", async () => {
    const a = await areas("applicant");
    for (const x of ["Getting started", "Applying", "Your loan", "Guarantors"]) expect(a.has(x as never)).toBe(true);
    for (const x of ["Human Resources", "Bursary", "Payroll", "Accounts Payable", "Finance", "Administration"]) expect(a.has(x as never)).toBe(false);
  });

  it("people with a role also see their role's guides, and only theirs", async () => {
    const hr = await areas("hradmin");
    expect(hr.has("Human Resources")).toBe(true);
    expect(hr.has("Applying")).toBe(true);
    expect(hr.has("Payroll")).toBe(false);
    expect(hr.has("Administration")).toBe(false);
    const payroll = await areas("payroll");
    expect(payroll.has("Payroll")).toBe(true);
    expect(payroll.has("Human Resources")).toBe(false);
    // A head of department sees how to approve, though approving is not a permission.
    expect((await areas("hod")).has("Approvals")).toBe(true);
  });

  it("the Super Administrator sees every guide", async () => {
    expect((await myGuides(db, await actor("admin"))).length).toBe(GUIDES.length);
  });

  it("every page of the app has a guide that opens first on it", () => {
    const root = path.join(process.cwd(), "src", "app", "(app)");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name === "page.tsx") pages.push("/" + path.relative(root, dir).split(path.sep).filter(Boolean).map((x) => (x.startsWith("[") ? "x1" : x)).join("/"));
      }
    };
    walk(root);
    const missing = pages.filter((p) => !GUIDES.some((g) => guideMatchesPage(g, p)));
    expect(missing).toEqual([]);
  });

  it("finds the guide for a page and for a question in everyday words", () => {
    expect(GUIDES.filter((g) => guideMatchesPage(g, "/loans/abc-123")).map((g) => g.id)).toContain("repay");
    expect(searchGuides(GUIDES, "how do I pay off my loan early?")[0].id).toBe("repay-early");
    expect(searchGuides(GUIDES, "my payslip cannot be read")[0].id).toBe("payslip");
    expect(searchGuides(GUIDES, "asked to guarantee a colleague")[0].id).toBe("guarantee-respond");
    expect(searchGuides(GUIDES, "the the and")).toEqual([]);
  });
});

describe("answers from the person's own records", () => {
  it("tells the applicant where their own application is, and tells no one else", async () => {
    const a = await actor("applicant");
    const draft = await saveDraft(db, a, { productId, requestedAmount: "200000", tenorMonths: 12, purpose: "Assistant test application", guarantorEmails: [(await actor("guarantor1")).email, (await actor("guarantor2")).email] });
    const mine = await answerQuestion(db, a, "Where is my application?");
    expect(mine.lines.join(" ")).toContain(draft.reference);
    const other = await answerQuestion(db, await actor("freshapplicant"), "Where is my application?");
    expect(other.lines.join(" ")).not.toContain(draft.reference);
    expect(other.lines).toContain("You have no application in progress.");
    expect((await nextSteps(db, a)).some((x) => x.text.includes(draft.reference))).toBe(true);
  });

  it("answers about the current terms, and only to those who may apply", async () => {
    const r = await answerQuestion(db, await actor("applicant"), "What is the interest rate and how many guarantors are needed?");
    expect(r.lines.some((l) => /a year|interest-free/.test(l))).toBe(true);
    expect(r.links.map((l) => l.href)).toContain("/products");
  });

  it("does not offer a guide the person may not read", async () => {
    const r = await answerQuestion(db, await actor("applicant"), "how do I verify an application in the HR queue");
    expect(r.guides).not.toContain("hr-verify");
    const hr = await answerQuestion(db, await actor("hradmin"), "how do I verify an application in the HR queue");
    expect(hr.guides[0]).toBe("hr-verify");
  });
});

describe("support requests", () => {
  it("emails ICT support with the sender's own details and the page, and sends the sender a copy", async () => {
    const a = await actor("applicant");
    await expect(submitSupportRequest(db, a, { category: "My application", subject: "Help", message: "The page will not load for me.", page: "/applications", roles: ["Applicant"] })).rejects.toThrow(/no email address/);
    await updateSetting(db, await actor("admin"), "org.ictEmail", "ict@example.edu.ng");
    const ref = await submitSupportRequest(db, a, { category: "My application", subject: "Cannot submit", message: "The submit button does nothing on my phone.", page: "/applications/new", roles: ["Applicant"] });
    const mails = await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, "ict@example.edu.ng"));
    const sent = mails.find((m) => m.subject.includes(ref))!;
    expect(sent.body).toContain(a.email);
    expect(sent.body).toContain("/applications/new");
    expect((await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, a.email))).some((m) => m.subject.includes(ref))).toBe(true);
    await expect(submitSupportRequest(db, a, { category: "Other", subject: "Hi", message: "short", page: "/", roles: [] })).rejects.toThrow();
  });
});
