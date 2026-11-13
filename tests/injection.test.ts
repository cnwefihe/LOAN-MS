/** SQL injection: classic attack strings typed into search and form fields are treated as plain text, never as SQL. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-sqli-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { searchUsers } from "@/server/services/admin";
import { addUser } from "@/server/services/user-setup";

const ATTACKS = [
  "administrator'--",
  "admin' --",
  "' OR '1'='1",
  "' OR 1=1 --",
  "\" OR \"\"=\"",
  "'; DROP TABLE users; --",
  "1; DELETE FROM users",
  "' UNION SELECT email, null, null FROM users --",
  "%' AND 1=1 --",
  "\\'; SELECT pg_sleep(5); --",
];

let db: Database;
let admin: Actor;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => { await seedBase(tx); await seedFixtures(tx); });
  const [first] = await db.select({ userId: s.userRoles.userId }).from(s.userRoles).innerJoin(s.roles, eq(s.roles.id, s.userRoles.roleId)).where(eq(s.roles.code, "SUPER_ADMIN"));
  admin = (await loadActor(db, first.userId))!;
});

describe("SQL injection", () => {
  it("search treats attack strings as text: no extra rows, no errors, nothing deleted", async () => {
    const before = (await db.select({ n: sql<number>`count(*)` }).from(s.users))[0].n;
    for (const q of ATTACKS) {
      const started = Date.now();
      expect(await searchUsers(db, admin, q), q).toEqual([]);
      expect(Date.now() - started, q).toBeLessThan(3000);
    }
    expect((await db.select({ n: sql<number>`count(*)` }).from(s.users))[0].n).toBe(before);
  });

  it("form fields store attack strings literally", async () => {
    const name = "Robert'); DROP TABLE users; --";
    await addUser(db, admin, { name, email: "robert.tables@example.edu.ng" });
    const [u] = await db.select().from(s.users).where(eq(s.users.email, "robert.tables@example.edu.ng"));
    expect(u.displayName).toBe(name);
    expect((await db.select({ n: sql<number>`count(*)` }).from(s.users))[0].n).toBeGreaterThan(1);
    await expect(addUser(db, admin, { name: "Admin", email: "administrator'--@example.edu.ng" })).rejects.toThrow();
  });
});
