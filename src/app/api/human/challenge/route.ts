import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { getDb } from "@/db";
import { devLoginEnabled } from "@/lib/auth/session";
import { newChallenge } from "@/server/human-check";
import { DEVICE_COOKIE, lockedFor, lockMessage } from "@/server/human-lock";
import { rateLimit } from "@/server/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** A new image for the security verification before sign-in, unless this device is locked out. */
export async function GET(req: NextRequest) {
  // Counted per device, never per network address: most staff share the campus address.
  const device = req.cookies.get(DEVICE_COOKIE)?.value;
  if (device) {
    try {
      await rateLimit(`human-new:${device}`, 60, 600);
    } catch {
      return NextResponse.json({ error: "Too many attempts. Please wait a few minutes and try again." }, { status: 429, headers: NO_STORE });
    }
  }
  const wait = device ? await lockedFor(await getDb(), device) : 0;
  const res = wait
    ? NextResponse.json({ error: lockMessage(wait), retryAfter: wait }, { status: 423, headers: NO_STORE })
    : NextResponse.json(newChallenge({ dev: devLoginEnabled() }), { headers: NO_STORE });
  if (!device) {
    res.cookies.set(DEVICE_COOKIE, crypto.randomUUID(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/human", maxAge: 365 * 24 * 3600 });
  }
  return res;
}
