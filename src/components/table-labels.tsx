"use client";

import { useEffect, useRef } from "react";

/** Copies each column heading onto its cells, so a table can show as cards on a phone (see globals.css). */
export function TableLabels() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const table = marker.current?.parentElement?.querySelector("table");
    if (!table) return;
    const label = () => {
      const heads = [...table.querySelectorAll("thead th")].map((th) => (th.querySelector(".sr-only") ? "" : th.textContent?.trim() ?? ""));
      for (const row of table.querySelectorAll("tbody tr, tfoot tr")) {
        let col = 0;
        for (const cell of (row as HTMLTableRowElement).cells) {
          if (cell.colSpan > 1) cell.dataset.label = "";
          else cell.dataset.label = heads[col] ?? "";
          col += cell.colSpan;
        }
      }
    };
    label();
    const watch = new MutationObserver(label);
    watch.observe(table, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  return <span ref={marker} hidden />;
}
