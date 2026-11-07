/**
 * Email delivery end to end: notification → outbox → branded HTML → Microsoft identity token →
 * Graph sendMail, against a local double of the Microsoft endpoints (tests/support/fake-graph.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { startFakeGraph, type FakeGraph } from "./support/fake-graph.mjs";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-email-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { notify } from "@/server/notifications";
import { processOutbox, GraphTransport, composeEmail, emailStatus } from "@/server/email";
import { sendTestEmail, updateSettingsGroup } from "@/server/services/admin";
import { getBranding } from "@/server/branding";

let db: Database;
let graph: FakeGraph;
const ids: Record<string, string> = {};

function useGraph(secret = "test-secret") {
  Object.assign(process.env, {
    EMAIL_TRANSPORT: "graph", EMAIL_GRAPH_TENANT_ID: "contoso-tenant", EMAIL_GRAPH_CLIENT_ID: "test-client", EMAIL_GRAPH_CLIENT_SECRET: secret,
    EMAIL_SENDER_ADDRESS: "loans@example.edu.ng", GRAPH_BASE_URL: graph.url, ENTRA_AUTHORITY_HOST: graph.url,
  });
}

beforeAll(async () => {
  graph = await startFakeGraph();
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});
afterAll(async () => {
  for (const k of ["EMAIL_TRANSPORT", "EMAIL_GRAPH_TENANT_ID", "EMAIL_GRAPH_CLIENT_ID", "EMAIL_GRAPH_CLIENT_SECRET", "EMAIL_SENDER_ADDRESS", "GRAPH_BASE_URL", "ENTRA_AUTHORITY_HOST"]) delete process.env[k];
  await graph.close();
});

describe("email through Microsoft 365 (Graph)", () => {
  it("reports itself unconfigured and records messages as not sent without a transport", async () => {
    delete process.env.EMAIL_TRANSPORT;
    expect(emailStatus().configured).toBe(false);
    await notify(db, { template: "application.submitted", userIds: [ids.applicant], vars: { reference: "APP-TEST-1", amount: "N1", product: "Test" }, link: "/applications" });
    const r = await processOutbox(50);
    expect(r.skipped).toBeGreaterThan(0);
    expect(graph.captured).toHaveLength(0);
    const rows = await db.select().from(s.emailOutbox);
    expect(rows.every((x) => x.status === "not_configured")).toBe(true);
  });

  it("delivers a branded HTML message with the logo inline and the security markings", async () => {
    useGraph();
    process.env.APP_BASE_URL = "https://loans.example.edu.ng";
    expect(emailStatus()).toEqual({ configured: true, detail: "Microsoft 365 via Graph, sending as loans@example.edu.ng" });
    await notify(db, { template: "loan.disbursed", userIds: [ids.applicant], link: "/loans/abc", vars: { accountNumber: "LMS-261031-001", amount: "₦500,000.00", date: "31 Oct 2026", txnRef: "FT-1", instalment: "₦43,750.00", firstDue: "25 Nov 2026" } });
    const r = await processOutbox(50);
    expect(r.sent).toBe(1);
    const mail = graph.captured.at(-1)!;
    expect(mail.sender).toBe("loans@example.edu.ng");
    expect(mail.to).toBe("adaeze.okafor.dev@example.edu.ng");
    expect(mail.contentType).toBe("HTML");
    expect(mail.subject).toContain("LMS-261031-001");
    expect(mail.html).toContain("Loan Management System");
    expect(mail.html).toContain("CONFIDENTIAL");
    expect(mail.html).toContain("Pan-Atlantic University. Authorised User Only.");
    expect(mail.html).toContain('href="https://loans.example.edu.ng/loans/abc"');
    expect(mail.html).toContain("cid:brand-logo");
    expect(mail.attachments).toEqual([expect.objectContaining({ contentId: "brand-logo", isInline: true, contentType: "image/png" })]);
    expect(mail.attachments[0].bytes).toBeGreaterThan(1000);
    expect(mail.saveToSentItems).toBe(false);
    expect(`${mail.subject}${mail.html}`).not.toMatch(/\u2014/);
  });

  it("reuses the access token until it nears expiry", async () => {
    const before = graph.stats.tokenRequests;
    for (let i = 0; i < 3; i++) await notify(db, { template: "repayment.confirmed", userIds: [ids.applicant], vars: { accountNumber: "LN-1", amount: `₦${i}`, reference: `R-${i}`, balance: "₦0" }, dedupeKey: `tok-${i}` });
    expect((await processOutbox(50)).sent).toBe(3);
    expect(graph.stats.tokenRequests - before).toBeLessThanOrEqual(1);
  });

  it("records a rejected recipient as failed with Microsoft's reason, and retries later", async () => {
    await db.update(s.users).set({ email: "bounce.dev@example.edu.ng" }).where(eq(s.users.id, ids.linemanager));
    await notify(db, { template: "application.declined", userIds: [ids.linemanager], vars: { reference: "APP-X", reason: "Test" } });
    const r = await processOutbox(50);
    expect(r.failed).toBe(1);
    const [row] = await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, "bounce.dev@example.edu.ng"));
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/ErrorInvalidRecipients/);
    expect(row.attempts).toBe(1);
    await processOutbox(50); // failed messages are retried (up to 5 attempts)
    const [again] = await db.select().from(s.emailOutbox).where(eq(s.emailOutbox.id, row.id));
    expect(again.attempts).toBe(2);
  });

  it("surfaces a wrong client secret as a clear token error", async () => {
    const t = new GraphTransport({ tenantId: "contoso-tenant", clientId: "test-client", clientSecret: "wrong", sender: "loans@example.edu.ng", graphBase: graph.url, authorityHost: graph.url });
    await expect(t.send({ to: "a@example.edu.ng", subject: "x", html: "<p>x</p>", text: "x" })).rejects.toThrow(/invalid_client/);
  });

  it("administrators can send a test email, and the sign-off follows the settings", async () => {
    const admin = (await loadActor(db, ids.admin, { ip: "127.0.0.1", userAgent: "vitest" }))!;
    await updateSettingsGroup(db, admin, "Notifications", { "notifications.emailSignature": "Bursary Loans Desk" }, false);
    await expect(sendTestEmail(db, admin, "not-an-email", "Loan Management System")).rejects.toThrow(/valid email/);
    await sendTestEmail(db, admin, "emeka.nwosu.dev@example.edu.ng", "Loan Management System");
    await processOutbox(50);
    const mail = graph.captured.find((m) => m.subject === "Test email from the Loan Management System")!;
    expect(mail.to).toBe("emeka.nwosu.dev@example.edu.ng");
    expect(mail.html).toContain("Bursary Loans Desk");
    const audit = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "email.test_sent"));
    expect(audit).toHaveLength(1);
  });

  it("escapes user-supplied text in the HTML body", async () => {
    const b = await getBranding(db);
    const { html } = composeEmail(b, "Hello <b>", "Purpose: <script>alert(1)</script>\n\nOpen: https://x.test/a?b=1&c=2", true);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://x.test/a?b=1&amp;c=2"');
  });
});
