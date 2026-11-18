import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { checkAnswer, HUMAN_COOKIE, passCookie, passSeconds, type Trail } from "@/server/human-check";
import { getSetting } from "@/server/settings";
import { clearFailures, DEVICE_COOKIE, lockedFor, lockMessage, recordFailure } from "@/server/human-lock";
import { rateLimit } from "@/server/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Checks the security verification; on success, sets the cookie that opens the sign-in page. */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  let body: { token?: unknown; x?: unknown; trail?: unknown; method?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Verification failed. Please try again." }, { status: 400, headers: NO_STORE });
  }
  try {
    await rateLimit(`human-try:${ip}`, 100, 600);
  } catch {
    return NextResponse.json({ ok: false, message: "Too many attempts. Please wait a few minutes and try again." }, { status: 429, headers: NO_STORE });
  }
  const db = await getDb();
  // Failures count per device; without the device cookie, per network address.
  const device = req.cookies.get(DEVICE_COOKIE)?.value ?? `ip:${ip}`;
  const wait = await lockedFor(db, device);
  if (wait) return NextResponse.json({ ok: false, message: lockMessage(wait), retryAfter: wait }, { headers: NO_STORE });

  const r = checkAnswer(String(body.token ?? ""), Number(body.x), (Array.isArray(body.trail) ? body.trail : []) as Trail, body.method === "keyboard" ? "keyboard" : "pointer");
  // Each image can be used once.
  let fresh = r.ok;
  if (r.ok) {
    try { await rateLimit(`human-used:${r.id}`, 1, 600); } catch { fresh = false; }
  }
  if (!fresh) {
    const f = await recordFailure(db, device);
    if (f.lockedFor) return NextResponse.json({ ok: false, message: lockMessage(f.lockedFor), retryAfter: f.lockedFor }, { headers: NO_STORE });
    const why = !r.ok && r.reason === "expired" ? "Verification timed out." : "Verification failed.";
    return NextResponse.json({ ok: false, message: `${why} Please try again. ${f.left} ${f.left === 1 ? "attempt" : "attempts"} left.` }, { headers: NO_STORE });
  }
  await clearFailures(db, device);
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  const valid = await getSetting(db, "security.verifyValidMinutes");
  res.cookies.set(HUMAN_COOKIE, passCookie(valid), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: passSeconds(valid) });
  return res;
}
