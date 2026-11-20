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
import { answerQuestion, myGuides, nextSteps, submitSignInSupportRequest, submitSupportRequest } from "@/server/services/assistant";
import { GUIDES, guideMatchesPage, publicGuides, searchGuides } from "@/lib/assistant/guides";
import { updateSetting } from "@/server/services/admin";
import { getSettings } from "@/server/settings";

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
    pages.push("/login", "/mfa");
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

describe("before signing in", () => {
  it("the sign-in pages offer only sign-in help: the security check, Microsoft sign-in and two-step codes", () => {
    const pub = publicGuides();
    expect(pub.map((g) => g.area)).toEqual(pub.map(() => "Signing in"));
    expect(pub.filter((g) => guideMatchesPage(g, "/login")).map((g) => g.id)).toEqual(["signin-check", "signin-microsoft", "signed-out"]);
    expect(pub.filter((g) => guideMatchesPage(g, "/mfa")).map((g) => g.id)).toEqual(["mfa-setup", "mfa-code", "signed-out"]);
    expect(searchGuides(pub, "my code is refused")[0].id).toBe("mfa-code");
    expect(searchGuides(pub, "the slider piece will not fit")[0].id).toBe("signin-check");
    expect(searchGuides(pub, "how do I set up the authenticator for the first time")[0].id).toBe("mfa-setup");
  });

  it("signed-in staff can read the sign-in help too", async () => {
    expect((await myGuides(db, await actor("applicant"))).some((g) => g.id === "mfa-code")).toBe(true);
  });

  it("someone who cannot sign in can reach ICT support, with a work email only", async () => {
    await updateSetting(db, await actor("admin"), "org.ictEmail", "ict@example.edu.ng");
    const base = { name: "Kemi Ade", category: "Two-step verification code", subject: "Lost my phone", message: "I changed my phone and lost the codes.", page: "/mfa", ip: "203.0.113.5" };
    await expect(submitSignInSupportRequest(db, { ...base, email: "someone@gmail.com" })).rejects.toThrow(/work email/);
    const ref = await submitSignInSupportRequest(db, { ...base, email: "kemi.ade@example.edu.ng" });
    const sent = (await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, "ict@example.edu.ng"))).find((m) => m.subject.includes(ref))!;
    expect(sent.body).toContain("kemi.ade@example.edu.ng");
    expect(sent.body).toContain("/mfa");
    expect((await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, "kemi.ade@example.edu.ng"))).some((m) => m.subject.includes(ref))).toBe(true);
  });
});

describe("support request limit", () => {
  it("is 3 an hour unless changed under Settings > Security, and only to the listed choices", async () => {
    expect(await getSettings(db, ["security.supportRequestsMax", "security.supportRequestsWindowMinutes"])).toEqual({ "security.supportRequestsMax": 3, "security.supportRequestsWindowMinutes": 60 });
    const admin = await actor("admin");
    await updateSetting(db, admin, "security.supportRequestsMax", 2);
    await updateSetting(db, admin, "security.supportRequestsWindowMinutes", 1440);
    expect(await getSettings(db, ["security.supportRequestsMax", "security.supportRequestsWindowMinutes"])).toEqual({ "security.supportRequestsMax": 2, "security.supportRequestsWindowMinutes": 1440 });
    await expect(updateSetting(db, admin, "security.supportRequestsMax", 1000)).rejects.toThrow();
    await expect(updateSetting(db, await actor("applicant"), "security.supportRequestsMax", 5)).rejects.toThrow();
  });
});

describe("support requests", () => {
  it("emails ICT support with the sender's own details and the page, and sends the sender a copy", async () => {
    const a = await actor("applicant");
    await updateSetting(db, await actor("admin"), "org.ictEmail", "");
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
