/**
 * Email delivery from the outbox through Microsoft 365 (Microsoft Graph sendMail).
 *
 * EMAIL_TRANSPORT=graph enables delivery. Credentials (application permission Mail.Send, restricted
 * by an Exchange application access policy or RBAC for Applications to the sender mailbox):
 *   EMAIL_GRAPH_TENANT_ID / EMAIL_GRAPH_CLIENT_ID / EMAIL_GRAPH_CLIENT_SECRET   (recommended: a separate app registration)
 *   falling back to ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET     (the sign-in app registration)
 *   EMAIL_SENDER_ADDRESS                                                       (shared mailbox, e.g. loans@example.edu.ng)
 * Optional: GRAPH_BASE_URL and ENTRA_AUTHORITY_HOST for national clouds (and the local test double).
 *
 * EMAIL_TRANSPORT unset: nothing is sent; queued messages are marked "not_configured" (visible in admin).
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, type Executor } from "@/db";
import { emailOutbox } from "@/db/schema";
import { getBranding, getLogo, type Branding } from "./branding";

export interface EmailMessage { to: string; subject: string; text: string; html: string; inlineImages?: { contentId: string; mimeType: string; bytes: Buffer }[] }
export interface EmailTransport { name: string; send(msg: EmailMessage): Promise<void> }

export interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; sender: string; graphBase?: string; authorityHost?: string }

export class GraphTransport implements EmailTransport {
  name = "graph";
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private cfg: GraphConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const host = (this.cfg.authorityHost ?? "https://login.microsoftonline.com").replace(/\/$/, "");
    const graph = (this.cfg.graphBase ?? "https://graph.microsoft.com").replace(/\/$/, "");
    const res = await fetch(`${host}/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: `${graph}/.default` }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Microsoft identity token request failed (${res.status}): ${body.error ?? ""} ${(body.error_description ?? "").slice(0, 200)}`.trim());
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(msg: EmailMessage) {
    const graph = (this.cfg.graphBase ?? "https://graph.microsoft.com").replace(/\/$/, "");
    const res = await fetch(`${graph}/v1.0/users/${encodeURIComponent(this.cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: "HTML", content: msg.html },
          toRecipients: [{ emailAddress: { address: msg.to } }],
          attachments: (msg.inlineImages ?? []).map((img) => ({
            "@odata.type": "#microsoft.graph.fileAttachment", name: `${img.contentId}.${img.mimeType === "image/jpeg" ? "jpg" : "png"}`,
            contentType: img.mimeType, contentBytes: img.bytes.toString("base64"), contentId: img.contentId, isInline: true,
          })),
        },
        saveToSentItems: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export function graphConfigFromEnv(): GraphConfig | null {
  const e = process.env;
  const tenantId = e.EMAIL_GRAPH_TENANT_ID || e.ENTRA_TENANT_ID;
  const clientId = e.EMAIL_GRAPH_CLIENT_ID || e.ENTRA_CLIENT_ID;
  const clientSecret = e.EMAIL_GRAPH_CLIENT_SECRET || e.ENTRA_CLIENT_SECRET;
  const sender = e.EMAIL_SENDER_ADDRESS;
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  return { tenantId, clientId, clientSecret, sender, graphBase: e.GRAPH_BASE_URL || undefined, authorityHost: e.ENTRA_AUTHORITY_HOST || undefined };
}

let cached: { key: string; transport: GraphTransport } | null = null;

export function getTransport(): EmailTransport | null {
  if (process.env.EMAIL_TRANSPORT !== "graph") return null;
  const cfg = graphConfigFromEnv();
  if (!cfg) {
    console.warn("[email] EMAIL_TRANSPORT=graph but the Graph credentials or EMAIL_SENDER_ADDRESS are missing");
    return null;
  }
  const key = JSON.stringify(cfg);
  if (cached?.key !== key) cached = { key, transport: new GraphTransport(cfg) };
  return cached.transport;
}

export function emailStatus(): { configured: boolean; detail: string } {
  if (process.env.EMAIL_TRANSPORT !== "graph") return { configured: false, detail: "EMAIL_TRANSPORT is not set to graph; emails are queued but not sent." };
  const cfg = graphConfigFromEnv();
  if (!cfg) return { configured: false, detail: "EMAIL_TRANSPORT=graph but credentials or EMAIL_SENDER_ADDRESS are missing." };
  return { configured: true, detail: `Microsoft 365 via Graph, sending as ${cfg.sender}` };
}

/* ───────────────────────── Branded HTML ───────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A block where every line is "Label: value" shows as a neat table; "- item" lines show as a list. */
function block(p: string, colour: string): string {
  const rows = p.split("\n");
  if (rows.length >= 2 && rows.every((r) => /^[^:\n]{2,30}: \S/.test(r))) {
    const cells = rows.map((r, i) => {
      const at = r.indexOf(": ");
      const line = i ? "border-top:1px solid #e2e8f0;" : "";
      return `<tr><td style="${line}padding:9px 14px;width:36%;font-size:13px;color:#5f6f86;vertical-align:top">${esc(r.slice(0, at))}</td><td style="${line}padding:9px 14px;font-size:14px;font-weight:600;color:#172033;vertical-align:top">${esc(r.slice(at + 2))}</td></tr>`;
    }).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid ${colour};border-radius:6px">${cells}</table>`;
  }
  if (rows.every((r) => r.startsWith("- "))) {
    return `<ul style="margin:0 0 14px;padding-left:20px">${rows.map((r) => `<li style="margin-bottom:4px">${esc(r.slice(2))}</li>`).join("")}</ul>`;
  }
  return `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`;
}

/**
 * Composes the institutional HTML email from the plain-text body stored in the outbox. A final
 * "Open: <url>" line becomes a button. Inline styles only: email clients ignore stylesheets.
 */
export function composeEmail(b: Branding, subject: string, text: string, hasLogo: boolean): { html: string; text: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  let link: string | null = null;
  const last = lines.findLastIndex((l) => /^Open: https?:\/\//.test(l.trim()));
  if (last >= 0) { link = lines[last].trim().slice(6); lines.splice(last, 1); }
  const c = b.primaryColour;
  const content = lines.join("\n").trim().split(/\n{2,}/).map((p) => block(p, c)).join("");
  const footer = `${b.systemName} · ${b.institutionName}`;
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><style>:root{color-scheme:light only;supported-color-schemes:light}</style><title>${esc(subject)}</title></head>
<body bgcolor="#f1f3f8" style="margin:0;padding:0;background:#f1f3f8;font-family:'Segoe UI',Arial,sans-serif;color:#172033">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f3f8" style="background:#f1f3f8;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-top:5px solid ${c};border-radius:8px;overflow:hidden">
<tr><td style="padding:22px 32px 18px;border-bottom:1px solid #e2e8f0">
${hasLogo ? `<img src="cid:brand-logo" alt="${esc(b.institutionName)}" height="44" style="display:block;height:44px;width:auto;border:0">` : `<strong style="font-size:17px;color:${c}">${esc(b.institutionName)}</strong>`}
</td></tr>
<tr><td style="padding:28px 32px 24px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;font-weight:600;color:${c}">${esc(subject)}</h1>
${content}
${link ? `<p style="margin:22px 0 6px"><a href="${esc(link)}" style="display:inline-block;background:${c};color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;padding:7px 16px;border-radius:6px">Open</a></p>` : ""}
<p style="margin:24px 0 0;color:#172033">Kind regards,<br><strong>${esc(b.emailSignature).replace(/\n/g, "<br>")}</strong></p>
</td></tr>
<tr><td align="center" style="padding:14px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#5f6f86">${esc(footer)}</td></tr></table>
</td></tr></table></body></html>`;
  const plain = `${lines.join("\n").trim()}${link ? `\n\nOpen: ${link}` : ""}\n\nKind regards,\n${b.emailSignature}\n\n${footer}`;
  return { html, text: plain };
}

export async function buildMessage(db: Executor, to: string, subject: string, body: string): Promise<EmailMessage> {
  const b = await getBranding(db);
  const logo = await getLogo(db, "logo");
  const { html, text } = composeEmail(b, subject, body, !!logo);
  return { to, subject, html, text, inlineImages: logo ? [{ contentId: "brand-logo", mimeType: logo.mimeType, bytes: logo.bytes }] : [] };
}

/* ───────────────────────── Dispatcher ───────────────────────── */

let running = false;

/** Deliver queued emails. Safe to call frequently; one dispatcher runs per process at a time. */
export async function processOutbox(limit = 50, transport: EmailTransport | null = getTransport()): Promise<{ sent: number; failed: number; skipped: number }> {
  if (running) return { sent: 0, failed: 0, skipped: 0 };
  running = true;
  try {
    const db = await getDb();
    const batch = await db.select().from(emailOutbox)
      .where(and(inArray(emailOutbox.status, ["queued", "failed"]), lt(emailOutbox.attempts, 5)))
      .limit(limit);
    let sent = 0, failed = 0, skipped = 0;
    for (const msg of batch) {
      if (!transport) {
        await db.update(emailOutbox).set({ status: "not_configured", lastError: "No email transport configured" }).where(eq(emailOutbox.id, msg.id));
        skipped++;
        continue;
      }
      try {
        await transport.send(await buildMessage(db, msg.toAddress, msg.subject, msg.body));
        await db.update(emailOutbox).set({ status: "sent", sentAt: new Date(), attempts: msg.attempts + 1, lastError: null }).where(eq(emailOutbox.id, msg.id));
        sent++;
      } catch (err) {
        await db.update(emailOutbox).set({ status: "failed", attempts: msg.attempts + 1, lastError: String(err).slice(0, 1000) }).where(eq(emailOutbox.id, msg.id));
        failed++;
      }
    }
    return { sent, failed, skipped };
  } finally {
    running = false;
  }
}

/** Fire-and-forget dispatch after a request commits. */
export function kickOutbox(): void {
  processOutbox().catch((err) => console.error("[email] outbox dispatch failed", err));
}
