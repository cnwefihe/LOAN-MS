"use client";

import { useRouter } from "next/navigation";

/** Rows per page. Changing it returns to the first page. */
export function PageSizeSelect({ id, value, options }: { id: string; value: number; options: { size: number; href: string }[] }) {
  const router = useRouter();
  return (
    <select id={id} aria-label="Rows per page" value={value} onChange={(e) => router.push(options.find((o) => o.size === Number(e.target.value))!.href)}
      className="tabular h-8 rounded-md border border-line bg-white px-2 text-sm font-medium text-ink">
      {options.map((o) => <option key={o.size} value={o.size}>{o.size}</option>)}
    </select>
  );
}
