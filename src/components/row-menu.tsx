"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";

const ITEM_HEIGHT = 36;
const ITEM = "block px-3 py-2 text-left text-sm text-ink hover:bg-slate-100 focus:bg-slate-100 focus:outline-none";

/**
 * Three-dot actions menu for a table row. The list is drawn over the page, because tables
 * scroll sideways and would otherwise cut it off.
 */
export function RowMenu({ label, items = [], children }: { label: string; items?: { label: string; href: string; download?: boolean }[]; children?: React.ReactNode }) {
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!place) return;
    menu.current?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
    const close = () => setPlace(null);
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [place]);

  const toggle = () => {
    if (place) return setPlace(null);
    const r = button.current!.getBoundingClientRect();
    const fits = r.bottom + (items.length + (children ? 2 : 0)) * ITEM_HEIGHT + 16 < window.innerHeight;
    setPlace({ right: window.innerWidth - r.right, ...(fits ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) });
  };

  return (
    <>
      <button ref={button} type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={!!place} aria-label={`Actions for ${label}`}
        className="-my-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-slate-100 hover:text-ink">
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </button>
      {place && createPortal(
        <div ref={menu} role="menu" aria-label={`Actions for ${label}`} style={place} className="fixed z-50 min-w-36 rounded-md border border-line bg-white py-1 shadow-lg">
          {items.map((i) => i.download
            ? <a key={i.href} role="menuitem" href={i.href} onClick={() => setPlace(null)} className={ITEM}>{i.label}</a>
            : <Link key={i.href} role="menuitem" href={i.href} onClick={() => setPlace(null)} className={ITEM}>{i.label}</Link>)}
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
