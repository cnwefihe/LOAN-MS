import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every request:
 *  - answers scanners probing for files and admin tools this server does not have, without revealing anything;
 *  - refuses methods the app does not use;
 *  - refuses state-changing requests sent from another site (cross-site request forgery);
 *  - gives each page a fresh script nonce, so only the app's own scripts can run.
 */

const PROBE = /(^|\/)\.(?!well-known\/)[^/]*|\.(php\d?|aspx?|jsp|cgi|pl|env|ini|sql|bak|old|orig|swp|log|config|ya?ml|sh)$|^\/(wp-|wordpress|phpmyadmin|pma|admin\.php|cgi-bin|server-status|server-info|actuator|console|vendor\/|xmlrpc|owa\/|autodiscover|telescope|debug|_profiler|elmah|trace\.axd|solr|jenkins|manager\/html)/i;
const METHODS = new Set(["GET", "HEAD", "POST"]);

const notFound = () => new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** The host the browser used, as passed on by the reverse proxy. */
function publicHost(req: NextRequest) {
  return (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
}

/** True when a browser sent this request from another site. Requests with no browser headers carry no session cookie of a victim. */
function crossSite(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin === "null") return true;
    try {
      return new URL(origin).host.toLowerCase() !== publicHost(req);
    } catch {
      return true;
    }
  }
  return false;
}

function contentSecurityPolicy(nonce: string, https: boolean) {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Style attributes and the brand colour sheet are inline; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://login.microsoftonline.com",
    "base-uri 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PROBE.test(path)) return notFound();
  if (!METHODS.has(req.method)) return new NextResponse(null, { status: 405, headers: { Allow: "GET, HEAD, POST" } });

  // The scheduler calls these with a secret token, not a browser session.
  if (req.method === "POST" && !path.startsWith("/api/cron/") && crossSite(req)) {
    return new NextResponse("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (path.startsWith("/api/")) return NextResponse.next();

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
  const csp = contentSecurityPolicy(nonce, req.headers.get("x-forwarded-proto") === "https");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    // Everything except the framework's own static files and the icons.
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|apple-icon\\.png).*)",
  ],
};
