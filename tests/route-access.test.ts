/**
 * Links on overview pages only lead where the person may go: the list of which permission opens which page
 * (lib/route-access.ts) must agree with every page's own check, so a link never ends on an access-denied page.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canOpen, linkIf } from "@/lib/route-access";
import { ALL_PERMISSIONS, type Permission } from "@/lib/auth/permissions";

const APP = path.join(process.cwd(), "src", "app", "(app)");

/** Every page under the signed-in area with the permissions its requireActor call accepts. */
function pages(dir = APP): { route: string; anyOf: Permission[] }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return pages(p);
    if (e.name !== "page.tsx") return [];
    const call = /requireActor\(([^)]*)\)/.exec(fs.readFileSync(p, "utf8"));
    if (!call) return [];
    const route = "/" + path.relative(APP, path.dirname(p)).split(path.sep).map((s) => (s.startsWith("[") ? "x" : s)).join("/");
    return [{ route: route === "/" ? "/" : route.replace(/\/$/, ""), anyOf: [...call[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as Permission) }];
  });
}

describe("route access", () => {
  it("agrees with every page's own permission check", () => {
    const list = pages();
    expect(list.length).toBeGreaterThan(40);
    const wrong: string[] = [];
    for (const { route, anyOf } of list) {
      for (const p of ALL_PERMISSIONS) {
        const page = !anyOf.length || anyOf.includes(p);
        if (canOpen(new Set([p]), route) !== page) wrong.push(`${route} with only ${p}: links say ${!page}, page says ${page}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("drops a link the person may not follow, and keeps the ones they may", () => {
    const hr = new Set<Permission>(["hr.queue.view"]);
    expect(linkIf(hr, "/hr/applications?status=pending_hr")).toBe("/hr/applications?status=pending_hr");
    expect(linkIf(hr, "/accounts/loans")).toBeUndefined();
    expect(linkIf(hr, "/reports")).toBeUndefined();
    expect(linkIf(new Set<Permission>(["fund.manage"]), "/finance#pool")).toBe("/finance#pool");
  });
});
