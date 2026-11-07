import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageSizeSelect } from "@/components/page-size-select";

export const PAGE_SIZE = 20;
export const PAGE_SIZES = [10, 20, 50, 100] as const;

export interface Page<T> { items: T[]; page: number; pages: number; total: number; size: number }

/** Slices a list for display. `page` and `size` come straight from the query string, so both are checked. */
export function paginate<T>(rows: T[], page?: string | null, size?: string | null): Page<T> {
  const chosen = Number(size);
  const perPage = (PAGE_SIZES as readonly number[]).includes(chosen) ? chosen : PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const n = Math.min(pages, Math.max(1, Number.parseInt(page ?? "1", 10) || 1));
  return { items: rows.slice((n - 1) * perPage, n * perPage), page: n, pages, total: rows.length, size: perPage };
}

const CELL = "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium";

function Step({ href, label, icon: Icon }: { href: string | null; label: string; icon: typeof ChevronLeft }) {
  return href
    ? <Link href={href} aria-label={label} title={label} className={`${CELL} text-slate-600 hover:bg-brand-50 hover:text-navy`}><Icon aria-hidden className="h-4 w-4" /></Link>
    : <span aria-disabled="true" className={`${CELL} text-slate-300`}><Icon aria-hidden className="h-4 w-4" /><span className="sr-only">{label}</span></span>;
}

/**
 * The one pager: rows per page and "1-20 of 132" on the left; previous, the current page and
 * next on the right. It keeps the page's other query parameters. Use a different `param`
 * for each list on the same page.
 */
export function Pagination({ data, base, params = {}, param = "page", label = "records" }: {
  data: Page<unknown>; base: string; params?: Record<string, string | undefined>; param?: string; label?: string;
}) {
  if (data.total <= PAGE_SIZES[0]) return null;
  const sizeParam = param === "page" ? "size" : `${param}Size`;
  const href = (n: number, size = data.size) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== param && k !== sizeParam) q.set(k, v);
    if (size !== PAGE_SIZE) q.set(sizeParam, String(size));
    if (n > 1) q.set(param, String(n));
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const from = (data.page - 1) * data.size + 1;
  const to = Math.min(data.total, data.page * data.size);
  const first = data.page > 1;
  const last = data.page < data.pages;
  return (
    <nav aria-label={`Pages of ${label}`} className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
        <PageSizeSelect id={`${param}-rows`} value={data.size} options={PAGE_SIZES.map((size) => ({ size, href: href(1, size) }))} />
        <p className="tabular"><span className="font-medium text-ink">{from.toLocaleString("en-GB")}-{to.toLocaleString("en-GB")}</span> of <span className="font-medium text-ink">{data.total.toLocaleString("en-GB")}</span></p>
      </div>
      {data.pages > 1 && (
        <ul className="flex items-center gap-0.5">
          <li><Step href={first ? href(data.page - 1) : null} label="Previous page" icon={ChevronLeft} /></li>
          <li><span aria-current="page" aria-label={`Page ${data.page} of ${data.pages}`} className={`${CELL} tabular bg-navy text-white`}>{data.page}</span></li>
          <li><Step href={last ? href(data.page + 1) : null} label="Next page" icon={ChevronRight} /></li>
        </ul>
      )}
    </nav>
  );
}
