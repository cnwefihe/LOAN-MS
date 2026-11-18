import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** The stylesheet only includes class names written out in full; one built at run time shows unstyled. */
describe("style class names", () => {
  it("are written out in full, never built from a variable", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /`(btn|bg|text|border)-\$\{/.test(fs.readFileSync(p, "utf8"))) found.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(found).toEqual([]);
  });
});
