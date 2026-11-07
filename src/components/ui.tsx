import { TableLabels } from "./table-labels";
import Link from "next/link";
import { ChevronRight, Info, CircleCheck, TriangleAlert, CircleX, Check, X } from "lucide-react";
import { formatNaira } from "@/lib/finance/money";
import { formatDate, formatDateTime } from "@/lib/finance/dates";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/* ───────── Page structure ───────── */

export interface Crumb { label: string; href?: string }

export function PageHeader({ title, description, crumbs, actions }: { title: string; description?: React.ReactNode; crumbs?: Crumb[]; actions?: React.ReactNode }) {
  return (
    <div className="mb-6">
      {crumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight aria-hidden className="h-3 w-3" />}
                {c.href ? <Link href={c.href} className="hover:text-brand hover:underline">{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ title, description, actions, children, className, bodyClassName }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "default", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "default" | "success" | "warning" | "danger" | "brand"; href?: string }) {
  const bar = { default: "bg-slate-300", success: "bg-success", warning: "bg-warning", danger: "bg-danger", brand: "bg-brand" }[tone];
  const body = (
    <div className="card relative h-full overflow-hidden px-4 py-3.5">
      <span aria-hidden className={cx("absolute inset-y-0 left-0 w-1", bar)} />
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="tabular mt-1 text-xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="block rounded-lg hover:ring-2 hover:ring-brand/20">{body}</Link> : body;
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/* ───────── Data display ───────── */

export function Money({ value, className }: { value: string | number | null | undefined; className?: string }) {
  return <span className={cx("tabular whitespace-nowrap", className)}>{formatNaira(value)}</span>;
}

export function DateText({ value, withTime }: { value: string | Date | null | undefined; withTime?: boolean }) {
  return <span className="whitespace-nowrap">{withTime ? formatDateTime(value) : formatDate(value)}</span>;
}

export function KeyValues({ items, columns = 2, size = "md" }: { items: [React.ReactNode, React.ReactNode][]; columns?: 1 | 2 | 3 | 6; size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <dl className={cx("grid", lg ? "gap-x-8 gap-y-4" : "gap-x-6 gap-y-3", columns === 1 ? "grid-cols-1" : columns === 2 ? "sm:grid-cols-2" : columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className={lg ? "text-[15px] font-semibold text-ink" : "text-xs text-muted"}>{k}</dt>
          <dd className={cx("break-words", lg ? "mt-1 text-sm leading-relaxed text-slate-600" : "mt-0.5 text-sm font-medium text-ink")}>{v ?? "N/A"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ caption, children, className }: { caption?: string; children: React.ReactNode; className?: string }) {
  return (
    // Focusable region so keyboard users can scroll wide tables (WCAG 2.1.1).
    <div className={cx("relative -mx-5 overflow-x-auto", className)} role="region" aria-label={caption ?? "Table"} tabIndex={0}>
      <table className="responsive-table min-w-full text-sm [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
      <TableLabels />
    </div>
  );
}

export function Th({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <th scope="col" className={cx("whitespace-nowrap border-b border-line bg-slate-50 px-5 py-2.5 text-sm font-semibold text-slate-700", right ? "text-right" : "text-left", className)}>{children}</th>;
}

export function Td({ children, right, className, colSpan }: { children?: React.ReactNode; right?: boolean; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={cx("border-b border-line px-5 py-2.5 align-top", right && "tabular text-right", className)}>{children}</td>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ───────── Status ───────── */

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";
const toneClass: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  info: "bg-brand-50 text-brand ring-brand-200",
  brand: "bg-navy text-white ring-navy",
  // Darker text shades keep badge labels ≥ 4.5:1 on their tinted backgrounds.
  success: "bg-success-50 text-green-800 ring-green-200",
  warning: "bg-warning-50 text-warning-ink ring-amber-200",
  danger: "bg-danger-50 text-red-800 ring-red-200",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={cx("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", toneClass[tone])}>{children}</span>;
}

const STATUS: Record<string, [string, Tone]> = {
  draft: ["Draft", "neutral"], pending_guarantor: ["Awaiting guarantors", "info"], pending_hr: ["Human Resources verification", "info"], returned: ["Returned for correction", "warning"],
  pending_bursary: ["Bursary review", "info"], pending_approval: ["Awaiting approval", "info"], approved: ["Approved", "success"], declined: ["Declined", "danger"], cancelled: ["Cancelled", "neutral"],
  pending: ["Pending", "info"], accepted: ["Accepted", "success"], clarification_requested: ["Clarification requested", "warning"], withdrawn: ["Withdrawn", "neutral"], replaced: ["Replaced", "neutral"],
  pending_disbursement: ["Awaiting disbursement", "info"], active: ["Active", "success"], overdue: ["Overdue", "warning"], defaulted: ["In default", "danger"], closed: ["Closed", "neutral"], written_off: ["Written off", "danger"],
  pending_confirmation: ["Awaiting confirmation", "warning"], confirmed: ["Confirmed", "success"], rejected: ["Rejected", "danger"],
  pending_approval_txn: ["Awaiting checker", "warning"], posted: ["Posted", "success"],
  partial: ["Part-paid", "warning"], paid: ["Paid", "success"], superseded: ["Superseded", "neutral"],
  verified: ["Verified", "success"], capable: ["Capable", "success"], not_capable: ["Not capable", "danger"], needs_review: ["Needs review", "warning"],
  retired: ["Retired", "neutral"], sent: ["Sent", "success"], failed: ["Failed", "danger"], queued: ["Queued", "info"], not_configured: ["Not sent (no transport)", "warning"],
  matched: ["Matched", "success"], short: ["Short", "warning"], over: ["Over", "warning"], missing: ["Missing", "danger"], claimed: ["Claimed, unconfirmed", "info"],
};

export function StatusBadge({ status, txn }: { status: string; txn?: boolean }) {
  const [label, tone] = STATUS[txn && status === "pending_approval" ? "pending_approval_txn" : status] ?? [status.replace(/_/g, " "), "neutral" as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Alert({ tone = "info", title, children }: { tone?: "info" | "success" | "warning" | "danger"; title?: string; children?: React.ReactNode }) {
  const Icon = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleX }[tone];
  const cls = { info: "border-brand-200 bg-brand-50 text-navy", success: "border-green-200 bg-success-50 text-green-900", warning: "border-amber-200 bg-warning-50 text-warning-ink", danger: "border-red-200 bg-danger-50 text-red-900" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-md border px-4 py-3 text-sm", cls)}>
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(title && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted"><span>{label}</span><span className="tabular">{v.toFixed(0)}%</span></div>
      <div className="h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-2 rounded-full bg-success" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

/** Horizontal stage tracker for the application → loan lifecycle. */
export function StageTracker({ stages, current, failed }: { stages: string[]; current: number; failed?: boolean }) {
  const at = Math.min(current, stages.length - 1);
  return (
    // Numbered steps joined by a line, evenly spaced. Containers 768px and wider show every label (centred,
    // one line); narrower ones (cards, phones) show the steps and name the current one beneath.
    <div className="@container">
      <ol className="flex" aria-label="Progress">
        {stages.map((s, i) => {
          const state = i < current ? "done" : i === current ? (failed ? "failed" : "current") : "todo";
          return (
            <li key={s} className="relative flex min-w-0 flex-1 flex-col items-center" aria-current={state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={cx("absolute right-1/2 top-3 h-0.5 w-full -translate-y-1/2", i <= current ? "bg-brand" : "bg-slate-200")} />}
              <span aria-hidden className={cx("relative z-10 grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold",
                state === "done" ? "bg-brand text-white" : state === "current" ? "bg-white text-brand ring-2 ring-brand" : state === "failed" ? "bg-danger text-white" : "bg-white text-muted ring-1 ring-slate-300")}>
                {state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : state === "failed" ? <X className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cx("sr-only mt-2 max-w-full truncate px-1 text-center text-[11px] leading-tight @3xl:not-sr-only", state === "todo" ? "text-muted" : "font-medium text-ink")}>
                {s}
                <span className="sr-only">: {state === "done" ? "complete" : state === "current" ? "in progress" : state === "failed" ? "stopped" : "not started"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="mt-2 text-xs text-muted @3xl:hidden">
        {current >= stages.length ? "Complete" : <>Step {at + 1} of {stages.length}: <span className={cx("font-medium", failed ? "text-danger" : "text-ink")}>{stages[at]}{failed ? " (stopped)" : ""}</span></>}
      </p>
    </div>
  );
}

export function Timeline({ items }: { items: { title: React.ReactNode; meta: React.ReactNode; body?: React.ReactNode }[] }) {
  if (!items.length) return <p className="text-sm text-muted">No activity yet.</p>;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {items.map((it, i) => (
        <li key={i} className="relative">
          <span aria-hidden className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand ring-1 ring-brand" />
          <p className="text-sm font-medium text-ink">{it.title}</p>
          <p className="text-xs text-muted">{it.meta}</p>
          {it.body && <div className="mt-1 whitespace-pre-line text-sm text-slate-700">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

/* ───────── Forms (server-rendered pieces) ───────── */

export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label">{label}</label>
      {children}
      {hint && <p id={`${htmlFor}-hint`} className="hint">{hint}</p>}
    </div>
  );
}

/** Forms inside a RowMenu use this for their button, with `className={MENU_FORM}` on the form. */
export const MENU_ACTION = "block w-full px-3 py-2 text-left text-sm text-ink hover:bg-slate-100 focus:bg-slate-100 focus:outline-none";
export const MENU_FORM = "[&>div]:flex [&>div]:w-full";

export function Tabs({ tabs, active, base }: { tabs: { key: string; label: string; count?: number }[]; active: string; base: string }) {
  return (
    <nav aria-label="Sections" className="relative mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <Link key={t.key} href={`${base}${base.includes("?") ? "&" : "?"}tab=${t.key}`} aria-current={active === t.key ? "page" : undefined}
          className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", active === t.key ? "border-brand font-semibold text-brand" : "border-transparent text-muted hover:text-ink")}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-700">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
