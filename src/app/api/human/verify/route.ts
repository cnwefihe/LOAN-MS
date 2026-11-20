import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { checkAnswer, HUMAN_COOKIE, passCookie, passSeconds, type Trail } from "@/server/human-check";
import { getSetting } from "@/server/settings";
import { clearFailures, DEVICE_COOKIE, lockedFor, lockMessage, recordFailure } from "@/server/human-lock";
import { rateLimit } from "@/server/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Checks the security verification; on success, sets the cookie that opens the sign-in page. */
export async function POST(req: NextRequest) {
  let body: { token?: unknown; x?: unknown; trail?: unknown; method?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Verification failed. Please try again." }, { status: 400, headers: NO_STORE });
  }
  const db = await getDb();
  // Counted per device, never per network address: most staff share the campus address. A browser that
  // keeps no cookies still has each image usable once and checked for a person's movement.
  const device = req.cookies.get(DEVICE_COOKIE)?.value ?? null;
  if (device) {
    try {
      await rateLimit(`human-try:${device}`, 30, 600);
    } catch {
      return NextResponse.json({ ok: false, message: "Too many attempts. Please wait a few minutes and try again." }, { status: 429, headers: NO_STORE });
    }
  }
  const wait = device ? await lockedFor(db, device) : 0;
  if (wait) return NextResponse.json({ ok: false, message: lockMessage(wait), retryAfter: wait }, { headers: NO_STORE });

  const r = checkAnswer(String(body.token ?? ""), Number(body.x), (Array.isArray(body.trail) ? body.trail : []) as Trail, body.method === "keyboard" ? "keyboard" : "pointer");
  // Each image can be used once.
  let fresh = r.ok;
  if (r.ok) {
    try { await rateLimit(`human-used:${r.id}`, 1, 600); } catch { fresh = false; }
  }
  if (!fresh) {
    const f = device ? await recordFailure(db, device) : { left: 1, lockedFor: 0 };
    if (f.lockedFor) return NextResponse.json({ ok: false, message: lockMessage(f.lockedFor), retryAfter: f.lockedFor }, { headers: NO_STORE });
    const why = !r.ok && r.reason === "expired" ? "Verification timed out." : "Verification failed.";
    return NextResponse.json({ ok: false, message: device ? `${why} Please try again. ${f.left} ${f.left === 1 ? "attempt" : "attempts"} left.` : `${why} Please try again.` }, { headers: NO_STORE });
  }
  if (device) await clearFailures(db, device);
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  const valid = await getSetting(db, "security.verifyValidMinutes");
  res.cookies.set(HUMAN_COOKIE, passCookie(valid), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: passSeconds(valid) });
  return res;
}
