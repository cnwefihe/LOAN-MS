/** References run on from day to day and go past 999, never starting again at 001. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-refs-"));

import { getDb, type Database } from "@/db";
import { nextReference, REFERENCE_PATTERN } from "@/server/references";

let db: Database;
beforeAll(async () => { db = await getDb(); });

describe("references", () => {
  it("carry on above the old daily counters, run on across days and go past 999", async () => {
    // Left by the old daily counters: the 4th was the highest number given out on any day.
    await db.execute(sql`insert into reference_counters (prefix, value) values ('LMS-261108', 4), ('LMS-261111', 1)`);
    const a = await nextReference(db, new Date("2026-11-12T10:00:00Z"));
    const b = await nextReference(db, new Date("2026-11-13T10:00:00Z"));
    expect(a).toBe("LMS-261112-005");
    expect(b).toBe("LMS-261113-006");
    await db.execute(sql`update reference_counters set value = 998 where prefix = 'LMS'`);
    expect(await nextReference(db, new Date("2026-11-13T10:00:00Z"))).toBe("LMS-261113-999");
    const big = await nextReference(db, new Date("2026-11-14T10:00:00Z"));
    expect(big).toBe("LMS-261114-1000");
    expect(big).toMatch(REFERENCE_PATTERN);
  });
});
