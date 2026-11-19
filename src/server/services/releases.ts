import { desc, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { releases, users, notifications } from "@/db/schema";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";

export const INITIAL_VERSION = "1.0";
const VERSION = /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;

const parts = (v: string) => v.split(".").map(Number);
/** True when version a is later than b, e.g. 1.10 > 1.9. */
export function isLater(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export async function listReleases(db: Executor) {
  const rows = await db.select({ r: releases, by: users.displayName }).from(releases).leftJoin(users, eq(users.id, releases.publishedBy)).orderBy(desc(releases.publishedAt));
  return rows.sort((a, b) => (isLater(a.r.version, b.r.version) ? -1 : 1));
}

export async function currentVersion(db: Executor): Promise<string> {
  return (await listReleases(db))[0]?.r.version ?? INITIAL_VERSION;
}

/** Records the first release once, so every installation starts at version 1.0. */
export async function ensureInitialRelease(db: Executor) {
  await db.insert(releases).values({ version: INITIAL_VERSION, title: "First release", notes: "Loan applications, guarantors, Human Resources review, approvals, disbursement, repayments, reports and document verification." }).onConflictDoNothing();
}

/** Publishes a new version and tells every active member of staff through an in-app notification. */
export async function publishRelease(db: Executor, actor: Actor, input: { version: string; title: string; notes: string }) {
  assertCan(actor, "admin.releases.manage");
  const version = input.version.trim().replace(/^v/i, "");
  const title = input.title.trim();
  const notes = input.notes.trim();
  if (!VERSION.test(version)) throw new DomainError("Enter the version as numbers, for example 1.1 or 1.1.2.");
  if (!title || title.length > 120) throw new DomainError("Enter a short title (up to 120 characters).");
  if (notes.length < 10) throw new DomainError("Describe what has changed.");
  const current = await currentVersion(db);
  if (!isLater(version, current)) throw new DomainError(`The new version must be later than the current version (${current}).`);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(releases).values({ version, title, notes, publishedBy: actor.userId }).returning();
    const staff = await tx.select({ id: users.id }).from(users).where(eq(users.isActive, true));
    if (staff.length) {
      await tx.insert(notifications).values(staff.map((u) => ({
        userId: u.id, templateCode: "system.release", title: `Version ${version}: ${title}`, body: notes, link: "/whats-new", dedupeKey: `release:${version}:${u.id}`,
      }))).onConflictDoNothing();
    }
    await audit(tx, actor, { action: "release.published", entityType: "release", entityId: row.id, summary: `Version ${version} published: ${title}`, after: { version, title } });
    return { release: row, notified: staff.length };
  });
}
