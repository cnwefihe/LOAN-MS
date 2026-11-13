/** The request guard: scanners get nothing, other sites cannot post as a signed-in user, and pages carry a script nonce. */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(new URL(path, "https://loan.example.edu"), { method: init.method ?? "GET", headers: { host: "loan.example.edu", ...init.headers } });

describe("request guard", () => {
  it("answers probes for files and tools the app does not have with a plain 404", async () => {
    for (const p of ["/.env", "/.git/config", "/wp-login.php", "/phpmyadmin/", "/backup.sql", "/server-status", "/config.yml", "/cgi-bin/x"]) {
      const r = proxy(req(p));
      expect(r.status, p).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
    expect(proxy(req("/.well-known/security.txt")).status).not.toBe(404);
  });

  it("refuses methods the app does not use", () => {
    for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS"]) expect(proxy(req("/dashboard", { method: m })).status, m).toBe(405);
  });

  it("refuses posts from another site and allows the app's own", () => {
    expect(proxy(req("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example.com" } })).status).toBe(403);
    expect(proxy(req("/applications/new", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(proxy(req("/api/auth/logout", { method: "POST", headers: { origin: "null" } })).status).toBe(403);
    expect(proxy(req("/api/auth/logout", { method: "POST", headers: { origin: "https://loan.example.edu", "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // Behind the reverse proxy the public name arrives in X-Forwarded-Host.
    expect(proxy(req("/api/session/activity", { method: "POST", headers: { host: "app:3000", "x-forwarded-host": "loan.example.edu", origin: "https://loan.example.edu" } })).status).toBe(200);
    // The scheduler uses a secret token, not a browser session.
    expect(proxy(req("/api/cron/reminders", { method: "POST", headers: { origin: "https://elsewhere.example.com" } })).status).toBe(200);
  });

  it("gives every page a fresh nonce and a strict script policy", () => {
    const a = proxy(req("/dashboard", { headers: { "x-forwarded-proto": "https" } })).headers.get("content-security-policy")!;
    const b = proxy(req("/dashboard")).headers.get("content-security-policy")!;
    expect(a).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
    expect(a).not.toContain("'unsafe-inline' 'strict"); // no inline scripts
    expect(a).toContain("object-src 'none'");
    expect(a).toContain("frame-ancestors 'none'");
    expect(a).toContain("upgrade-insecure-requests");
    expect(a.match(/nonce-([^']+)/)![1]).not.toBe(b.match(/nonce-([^']+)/)![1]);
  });
});
