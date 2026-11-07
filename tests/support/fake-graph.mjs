/**
 * Local test double for the two Microsoft endpoints the email transport uses:
 *   POST /{tenant}/oauth2/v2.0/token       (Microsoft identity platform, client credentials)
 *   POST /v1.0/users/{sender}/sendMail     (Microsoft Graph)
 * It validates credentials and the request shape like the real services and records every message.
 * Inspection: GET /_captured, DELETE /_captured, GET /_stats.
 * A recipient containing "bounce" is rejected the way Exchange rejects an invalid recipient.
 *
 * Used by the Vitest suites (import) and the Playwright run (node tests/support/fake-graph.mjs <port>).
 * This verifies our side of the integration only; it is not a test of the real Microsoft 365 tenant.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

export function startFakeGraph(port = 0, { clientId = "test-client", clientSecret = "test-secret" } = {}) {
  const captured = [];
  const tokens = new Set();
  const stats = { tokenRequests: 0, sendRequests: 0, rejected: 0 };

  const read = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await read(req);
    if (req.method === "GET" && url.pathname === "/_captured") return json(res, 200, captured);
    if (req.method === "DELETE" && url.pathname === "/_captured") { captured.length = 0; return json(res, 204); }
    if (req.method === "GET" && url.pathname === "/_stats") return json(res, 200, stats);

    const tokenMatch = url.pathname.match(/^\/([^/]+)\/oauth2\/v2\.0\/token$/);
    if (req.method === "POST" && tokenMatch) {
      stats.tokenRequests++;
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "client_credentials" || !form.get("scope")?.endsWith("/.default")) return json(res, 400, { error: "invalid_request" });
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return json(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      const token = `fake-token-${stats.tokenRequests}-${Math.random().toString(36).slice(2)}`;
      tokens.add(token);
      return json(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: token });
    }

    const sendMatch = url.pathname.match(/^\/v1\.0\/users\/([^/]+)\/sendMail$/);
    if (req.method === "POST" && sendMatch) {
      stats.sendRequests++;
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !tokens.has(auth.slice(7))) return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty or invalid." } });
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: { code: "RequestBodyRead", message: "Invalid JSON" } }); }
      const m = payload?.message;
      const to = m?.toRecipients?.[0]?.emailAddress?.address;
      if (!m?.subject || !m?.body?.content || !["HTML", "Text"].includes(m?.body?.contentType) || !to) return json(res, 400, { error: { code: "ErrorInvalidRequest", message: "Missing subject, body or recipient." } });
      if (to.includes("bounce")) { stats.rejected++; return json(res, 400, { error: { code: "ErrorInvalidRecipients", message: "At least one recipient is not valid." } }); }
      captured.push({ sender: decodeURIComponent(sendMatch[1]), to, subject: m.subject, contentType: m.body.contentType, html: m.body.content, attachments: (m.attachments ?? []).map((a) => ({ name: a.name, contentId: a.contentId, isInline: a.isInline, contentType: a.contentType, bytes: Buffer.from(a.contentBytes ?? "", "base64").length })), saveToSentItems: payload.saveToSentItems });
      res.writeHead(202);
      return res.end();
    }
    json(res, 404, { error: { code: "NotFound" } });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, captured, stats, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.argv[2] ?? 3199);
  startFakeGraph(port).then((g) => console.log(`Fake Microsoft Graph listening on ${g.url}`));
}
