"use client";

import { useRef, useState } from "react";
import { CalendarDays } from "lucide-react";

/** "02/03/2015" (day first) or "2015-03-02" to 2015-03-02; null when not a real date. */
export function parseDayFirst(text: string): string | null {
  const s = text.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** 2015-03-02 to "02/03/2015". */
export function toDayFirst(iso: string | null | undefined): string {
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
}

/** "2 March 2015", shown under the box so the reading is plain. */
const inWords = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * A date typed day first (DD/MM/YYYY) whatever the computer's own date setting, with a calendar to pick
 * from. The form receives the date as YYYY-MM-DD under `name`.
 */
export function DateInput({ id, name, defaultValue, required, min, max, className = "input", inWordsBelow = true }: {
  id: string; name: string; defaultValue?: string | null; required?: boolean; min?: string; max?: string; className?: string; inWordsBelow?: boolean;
}) {
  const [iso, setIso] = useState(parseDayFirst(toDayFirst(defaultValue)));
  const box = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const take = (el: HTMLInputElement) => {
    const value = el.value;
    const v = parseDayFirst(value);
    el.setCustomValidity(
      !value.trim() ? "" : !v ? "Enter the date as day, month and year, for example 02/03/2015."
        : max && v > max ? `The date cannot be after ${toDayFirst(max)}.` : min && v < min ? `The date cannot be before ${toDayFirst(min)}.` : "",
    );
    setIso(v);
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
      <input
        ref={box} id={id} type="text" inputMode="numeric" autoComplete="off" placeholder="DD/MM/YYYY" maxLength={10} required={required}
        defaultValue={toDayFirst(defaultValue)} className={`${className} pr-10`}
        onChange={(e) => {
          const el = e.target;
          // A pasted 2015-03-02 becomes 02/03/2015; dots and dashes become slashes.
          const pasted = /^\s*\d{4}-\d{1,2}-\d{1,2}\s*$/.test(el.value) ? parseDayFirst(el.value.trim().replace(/-(\d)(?=-|$)/g, "-0$1")) : null;
          let v = pasted ? toDayFirst(pasted) : el.value.replace(/[.\-]/g, "/").replace(/[^\d/]/g, "");
          // Add the slashes while typing: 0203 becomes 02/03/.
          if (/^\d{3,}$/.test(v)) v = `${v.slice(0, 2)}/${v.slice(2, 4)}${v.length > 4 ? `/${v.slice(4, 8)}` : ""}`;
          else if (/^\d{1,2}\/\d{3,}$/.test(v)) { const [a, b] = v.split("/"); v = `${a}/${b.slice(0, 2)}/${b.slice(2, 6)}`; }
          if (v !== el.value) el.value = v;
          take(el);
        }}
      />
      <button type="button" aria-label="Choose from a calendar" title="Choose from a calendar"
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted hover:text-brand"
        onClick={() => { const p = picker.current; if (!p) return; p.value = iso ?? ""; try { p.showPicker(); } catch { p.focus(); } }}>
        <CalendarDays aria-hidden className="h-4 w-4" />
      </button>
      <input ref={picker} type="date" tabIndex={-1} aria-hidden data-no-change min={min} max={max} className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
        onChange={(e) => { const el = box.current; if (el && e.target.value) { el.value = toDayFirst(e.target.value); take(el); } }} />
      </div>
      <input type="hidden" name={name} value={iso ?? ""} />
      {iso && inWordsBelow && <p className="hint" aria-live="polite">{inWords(iso)}</p>}
    </div>
  );
}
