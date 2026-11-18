/**
 * Remembers the page, search and filters last used on each list, so the breadcrumb back to a list
 * and the page shown after saving return to the same place rather than to page 1.
 * The browser keeps it in a session cookie: path -> query string.
 */
export const LIST_COOKIE = "lists";
const MAX_ENTRIES = 30;
const MAX_LENGTH = 3000;

export type ListMemory = Record<string, string>;

export function parseMemory(raw: string | undefined | null): ListMemory {
  if (!raw) return {};
  try {
    const v = JSON.parse(decodeURIComponent(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, q]) => k.startsWith("/") && typeof q === "string")) as ListMemory;
  } catch {
    return {};
  }
}

export function serialiseMemory(mem: ListMemory): string {
  const entries = Object.entries(mem);
  let out = encodeURIComponent(JSON.stringify(mem));
  // Drop the oldest entries until it fits.
  while (entries.length && (entries.length > MAX_ENTRIES || out.length > MAX_LENGTH)) {
    entries.shift();
    out = encodeURIComponent(JSON.stringify(Object.fromEntries(entries)));
  }
  return out;
}

/** Records a visit: the latest query for the path, or none when the list was opened plain (page 1). */
export function recordVisit(mem: ListMemory, pathname: string, search: string): ListMemory {
  const next = { ...mem };
  delete next[pathname];
  const q = search.replace(/^\?/, "");
  if (q) next[pathname] = q; // re-added last, so it counts as the newest
  return next;
}

/**
 * The remembered address for a link or redirect to a list. Only used when it keeps everything the
 * link asks for (for example the same tab); otherwise the link is left as it is.
 */
export function resolveBack(mem: ListMemory, href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const [path, query = ""] = href.split("#")[0].split("?");
  const saved = mem[path];
  if (!saved) return href;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(saved);
  for (const [k, v] of want) if (have.get(k) !== v) return href;
  return `${path}?${saved}`;
}
