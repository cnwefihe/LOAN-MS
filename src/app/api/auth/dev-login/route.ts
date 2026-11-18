/**
 * DEVELOPMENT FIXTURE LOGIN: not an authentication mechanism.
 * Lets developers sign in as seeded fixture users while Entra ID is not configured locally.
 * Hard-disabled when NODE_ENV=production, and only for users flagged is_dev_fixture.
 */
import { appUrl } from "@/lib/app-url";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { createSession, devLoginEnabled } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { hasPassed, HUMAN_COOKIE } from "@/server/human-check";

export async function POST(req: NextRequest) {
  if (!devLoginEnabled()) return new NextResponse("Not found", { status: 404 });
  if (!hasPassed(req.cookies.get(HUMAN_COOKIE)?.value)) return NextResponse.redirect(appUrl("/login?error=human_check", req), 303);
  const form = await req.formData();
  const userId = String(form.get("userId") ?? "");
  const db = await getDb();
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.isDevFixture, true), eq(users.isActive, true)));
  if (!u) return NextResponse.redirect(appUrl("/login?error=unknown_fixture", req), 303);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  await audit(db, { userId: u.id, email: u.email, displayName: u.displayName, roles: [], permissions: new Set() }, {
    action: "user.dev_fixture_login", entityType: "user", entityId: u.id, summary: "Signed in with DEVELOPMENT fixture login",
  });
  await createSession(u.id, "dev_fixture");
  return NextResponse.redirect(appUrl("/home", req), 303);
}
