/** The pager: page and rows-per-page values come from the address bar, so they must be checked. */
import { describe, expect, it } from "vitest";
import { paginate, PAGE_SIZE } from "@/components/pagination";

const rows = Array.from({ length: 132 }, (_, i) => i + 1);

describe("pagination", () => {
  it("defaults to 20 rows on the first page", () => {
    const p = paginate(rows);
    expect(p).toMatchObject({ page: 1, pages: 7, total: 132, size: PAGE_SIZE });
    expect(p.items).toHaveLength(20);
  });

  it("honours the listed rows per page and refuses anything else", () => {
    expect(paginate(rows, "1", "50").size).toBe(50);
    expect(paginate(rows, "1", "100").pages).toBe(2);
    expect(paginate(rows, "1", "7").size).toBe(PAGE_SIZE);
    expect(paginate(rows, "1", "100000").size).toBe(PAGE_SIZE);
    expect(paginate(rows, "1", "abc").size).toBe(PAGE_SIZE);
  });

  it("keeps the page within range", () => {
    expect(paginate(rows, "999").page).toBe(7);
    expect(paginate(rows, "999").items).toEqual([121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
    expect(paginate(rows, "-3").page).toBe(1);
    expect(paginate(rows, "x").page).toBe(1);
    expect(paginate([], "4")).toMatchObject({ page: 1, pages: 1, total: 0, items: [] });
  });

  it("shows no row twice and misses none across the pages", () => {
    const seen = Array.from({ length: 14 }, (_, i) => paginate(rows, String(i + 1), "10").items).flat();
    expect(seen).toEqual(rows);
  });
});
