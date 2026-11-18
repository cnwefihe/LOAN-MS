"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LIST_COOKIE, parseMemory, recordVisit, resolveBack, serialiseMemory } from "@/lib/list-memory";

function readMemory() {
  const m = document.cookie.split("; ").find((c) => c.startsWith(`${LIST_COOKIE}=`));
  return parseMemory(m?.slice(LIST_COOKIE.length + 1));
}

/** Notes the page, search and filters of each page visited, for links and redirects back to it. */
export function ListMemoryRecorder() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    const value = serialiseMemory(recordVisit(readMemory(), pathname, search));
    document.cookie = `${LIST_COOKIE}=${value}; path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }, [pathname, search]);
  return null;
}

/** A link back to a list that returns to the page, search and filters last used there. */
export function BackLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const [to, setTo] = useState(href);
  useEffect(() => setTo(resolveBack(readMemory(), href)), [href]);
  return <Link href={to} className={className}>{children}</Link>;
}
