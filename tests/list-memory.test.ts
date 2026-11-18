import { describe, expect, it } from "vitest";
import { parseMemory, recordVisit, resolveBack, serialiseMemory } from "@/lib/list-memory";

describe("list memory", () => {
  it("returns to the page and search last used on a list", () => {
    const mem = recordVisit({}, "/admin/users", "?q=ade&page=3");
    expect(resolveBack(mem, "/admin/users")).toBe("/admin/users?q=ade&page=3");
    expect(resolveBack(mem, "/admin/roles")).toBe("/admin/roles");
  });

  it("forgets when the list is opened plain", () => {
    const mem = recordVisit(recordVisit({}, "/admin/users", "page=3"), "/admin/users", "");
    expect(resolveBack(mem, "/admin/users")).toBe("/admin/users");
  });

  it("keeps what the link asks for, such as the tab", () => {
    const mem = recordVisit({}, "/admin/organisation", "tab=schools&page=2");
    expect(resolveBack(mem, "/admin/organisation?tab=schools")).toBe("/admin/organisation?tab=schools&page=2");
    expect(resolveBack(mem, "/admin/organisation?tab=departments")).toBe("/admin/organisation?tab=departments");
  });

  it("survives the cookie round trip, drops the oldest when full and ignores bad values", () => {
    let mem = {};
    for (let i = 0; i < 40; i++) mem = recordVisit(mem, `/list${i}`, `page=${i}`);
    const back = parseMemory(serialiseMemory(mem));
    expect(Object.keys(back)).toHaveLength(30);
    expect(back["/list39"]).toBe("page=39");
    expect(back["/list0"]).toBeUndefined();
    expect(parseMemory("not json")).toEqual({});
    expect(resolveBack({ "/x": "page=2" }, "https://elsewhere.example/x")).toBe("https://elsewhere.example/x");
  });
});
