import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-hlock-"));

import { getDb, type Database } from "@/db";
import { systemSettings } from "@/db/schema";
import { clearFailures, lockedFor, recordFailure } from "@/server/human-lock";

let db: Database;
beforeAll(async () => { db = await getDb(); });

describe("security verification lockout", () => {
  it("locks a device after the allowed failures, for the time set; other devices are not affected", async () => {
    await db.insert(systemSettings).values([{ key: "security.verifyMaxFailures", value: 3 }, { key: "security.verifyLockMinutes", value: 5 }])
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: sql`excluded.value` } });
    expect(await recordFailure(db, "dev-a")).toEqual({ left: 2, lockedFor: 0 });
    expect(await recordFailure(db, "dev-a")).toEqual({ left: 1, lockedFor: 0 });
    expect(await lockedFor(db, "dev-a")).toBe(0);
    expect(await recordFailure(db, "dev-a")).toEqual({ left: 0, lockedFor: 300 });
    const wait = await lockedFor(db, "dev-a");
    expect(wait).toBeGreaterThan(290);
    expect(wait).toBeLessThanOrEqual(300);
    expect(await lockedFor(db, "dev-b")).toBe(0);
  });

  it("the lock ends after the time set, and a success clears the count", async () => {
    await db.execute(sql`update rate_limits set window_start = now() - interval '6 minutes' where key = 'human-fail:dev-a'`);
    expect(await lockedFor(db, "dev-a")).toBe(0);
    expect(await recordFailure(db, "dev-a")).toEqual({ left: 2, lockedFor: 0 }); // counting starts again
    await clearFailures(db, "dev-a");
    expect(await recordFailure(db, "dev-a")).toEqual({ left: 2, lockedFor: 0 });
  });
});
