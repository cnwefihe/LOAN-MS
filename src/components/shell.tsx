"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard, Calculator, FileText, Wallet, User, Handshake, ClipboardCheck, Users, Gavel, Landmark, Banknote, Receipt, CircleCheck,
  Scale, Clock, ChartColumn, ShieldCheck, Package, Building2, BookOpen, Settings, ScrollText, Mail, Bell, Search, Menu, X, LogOut,
  PanelLeftClose, PanelLeftOpen, ChevronUp, Palette, FileCheck, Tag, FilePlus,
} from "lucide-react";
import type { IconName, NavSection } from "@/lib/nav";

const ICONS: Record<IconName, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  dashboard: LayoutDashboard, calculator: Calculator, file: FileText, wallet: Wallet, user: User, handshake: Handshake, clipboard: ClipboardCheck,
  users: Users, gavel: Gavel, landmark: Landmark, banknote: Banknote, receipt: Receipt, check: CircleCheck, scale: Scale, clock: Clock,
  chart: ChartColumn, shield: ShieldCheck, package: Package, building: Building2, book: BookOpen, settings: Settings, scroll: ScrollText, mail: Mail, bell: Bell, palette: Palette, verify: FileCheck, tag: Tag, plus: FilePlus,
};

function isActive(pathname: string, href: string) {
  if (href === "/dashboard" || href === "/hr" || href === "/accounts" || href === "/admin" || href === "/guarantor") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ sections, collapsed, onNavigate }: { sections: NavSection[]; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Highlight only the most specific match, so "New application" and "My applications" never light up together.
  const current = sections.flatMap((s) => s.items.map((i) => i.href)).filter((h) => isActive(pathname, h)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Main navigation" className="sidebar-scroll flex-1 overflow-y-auto px-3 py-5">
      {sections.map((s) => (
        <div key={s.title} className="mb-6 last:mb-0">
          {!collapsed && (
            <p className={`whitespace-nowrap px-3 pb-2 text-[11px] font-semibold uppercase text-white/60 ${s.title.length > 20 ? "tracking-[0.04em]" : "tracking-[0.12em]"}`}>{s.title}</p>
          )}
          <ul className="space-y-1">
            {s.items.map((it) => {
              const Icon = ICONS[it.icon];
              const active = it.href === current;
              return (
                <li key={it.href}>
                  <Link href={it.href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={collapsed ? it.label : undefined}
                    className={`group relative flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm transition-all duration-150 ${collapsed ? "justify-center" : ""} ${active
                      ? "bg-white/[0.12] font-semibold text-white"
                      : "text-white/80 hover:translate-x-0.5 hover:bg-white/[0.06] hover:text-white"}`}>
                    {active && <span aria-hidden className="absolute inset-y-2 -left-3 w-1 rounded-r-full bg-brand-200" />}
                    <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${active ? "bg-white/[0.14] text-white" : "text-white/75 group-hover:bg-white/[0.06] group-hover:text-white"}`}>
                      <Icon aria-hidden className="h-[17px] w-[17px]" />
                    </span>
                    {!collapsed && <span className="flex-1 truncate">{it.label}</span>}
                    {!!it.badge && (
                      <span className={`tabular rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-navy ${collapsed ? "absolute right-1 top-0.5" : ""}`}>
                        {it.badge}<span className="sr-only"> pending</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const MENU_ROW = "flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm transition-all duration-150 hover:translate-x-0.5 hover:bg-white/[0.06]";

/**
 * Who is signed in, at the foot of the menu. Clicking the avatar opens the choices in place to show
 * My profile and Sign out; clicking again (or anywhere else) folds it away.
 */
function SidebarUser({ user, collapsed, onNavigate }: { user: { name: string; email: string; roles: string[] }; collapsed: boolean; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const avatar = <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.14] text-xs font-semibold text-white ring-1 ring-white/20">{initials}</span>;
  const menu = (
      <div id="account-actions" className="space-y-0.5 p-1.5">
        <Link href="/profile" onClick={() => { setOpen(false); onNavigate?.(); }} className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-ink">
          <User aria-hidden className="h-4 w-4" /> My profile
        </Link>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-red-700 transition-colors hover:bg-slate-100">
            <LogOut aria-hidden className="h-4 w-4" /> Sign out
          </button>
        </form>
      </div>
  );

  if (collapsed) {
    // Narrow menu: the card opens beside the avatar, pointing at it.
    return (
      <div ref={ref} className="relative px-3 pb-4">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="account-actions" title={user.name} className={`flex w-full justify-center rounded-xl p-1.5 transition-colors hover:bg-white/[0.06] ${open ? "bg-white/[0.1]" : ""}`}>
          {avatar}<span className="sr-only">{user.name}, account options</span>
        </button>
        {open && (
          <div className="absolute bottom-3 left-full z-40 ml-3 w-40 rounded-xl border border-line bg-white shadow-xl shadow-slate-900/20">
            <span aria-hidden className="absolute -left-[7px] bottom-5 h-3.5 w-3.5 rotate-45 border-b border-l border-line bg-white" />
            {menu}
          </div>
        )}
      </div>
    );
  }
  return (
    <div ref={ref} className="px-3 pb-4 pt-2">
      {open && (
        <div id="account-actions" className="mb-2 space-y-0.5 border-t border-white/10 pt-2">
          <Link href="/profile" onClick={() => { setOpen(false); onNavigate?.(); }} className={`${MENU_ROW} text-white/80 hover:text-white`}>
            <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center"><User className="h-[17px] w-[17px]" /></span> My profile
          </Link>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={`${MENU_ROW} text-red-300 hover:text-red-200`}>
              <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center"><LogOut className="h-[17px] w-[17px]" /></span> Sign out
            </button>
          </form>
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="account-actions"
        className={`flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-white/[0.06] ${open ? "bg-white/[0.1]" : ""}`}>
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{user.name}</span>
          <span className="block truncate text-[11px] text-white/70">{user.roles.join(" · ") || "Staff"}</span>
        </span>
        <ChevronUp aria-hidden className={`mr-1 h-4 w-4 text-white/60 transition-transform duration-200 ${open ? "" : "rotate-180"}`} />
        <span className="sr-only">account options</span>
      </button>
    </div>
  );
}

/**
 * Search shows as an icon beside the notifications. Clicking it opens the box; suggestions appear as you
 * type, Enter shows all results, and clicking elsewhere closes it back to the icon.
 */
function HeaderSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<{ kind: string; label: string; detail: string; href: string }[]>([]);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setQ(""); setItems([]); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((d: { suggestions: typeof items }) => { setItems(d.suggestions); setActive(-1); })
        .catch(() => {});
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const go = (href: string) => { setOpen(false); setQ(""); setItems([]); router.push(href); };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-navy" aria-label="Search">
        <Search aria-hidden className="h-5 w-5" />
      </button>
    );
  }
  return (
    <form ref={ref} action="/search" role="search" className="relative w-[min(24rem,calc(100vw-8rem))]"
      onSubmit={(e) => { if (active >= 0 && items[active]) { e.preventDefault(); go(items[active].href); } else { setOpen(false); } }}>
      <label htmlFor="global-search" className="sr-only">Search applications, loans and staff</label>
      <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input ref={input} id="global-search" name="q" type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setQ(""); setItems([]); }
          if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
          if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); }
        }}
        role="combobox" aria-expanded={items.length > 0} aria-controls="search-suggestions" aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `search-option-${active}` : undefined}
        placeholder="Search references, loans and staff" className="h-10 w-full rounded-full border border-brand-300 bg-white pl-10 pr-4 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-100" />
      {items.length > 0 && (
        <ul id="search-suggestions" role="listbox" className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-xl">
          {items.map((it, i) => (
            <li key={`${it.kind}-${it.href}`} id={`search-option-${i}`} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(it.href)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${i === active ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted">{it.kind}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{it.label}</span>
                <span className="truncate text-xs text-muted">{it.detail}</span>
              </button>
            </li>
          ))}
          <li role="presentation"><button type="submit" className="w-full border-t border-line px-3 py-2 text-left text-xs font-medium text-brand hover:bg-slate-50">See all results for &ldquo;{q.trim()}&rdquo;</button></li>
        </ul>
      )}
    </form>
  );
}

export interface ShellBrand { systemName: string; institutionName: string; logoWhite: string; crestWhite: string; version: string }

function Brand({ collapsed, brand, onToggle }: { collapsed: boolean; brand: ShellBrand; onToggle?: () => void }) {
  const toggle = onToggle && (
    <button type="button" onClick={onToggle} className="rounded-md p-1.5 text-white/75 hover:bg-white/10 hover:text-white" aria-label={collapsed ? "Expand menu" : "Minimise menu"} title={collapsed ? "Expand menu" : "Minimise menu"} aria-expanded={!collapsed}>
      {collapsed ? <PanelLeftOpen aria-hidden className="h-4 w-4" /> : <PanelLeftClose aria-hidden className="h-4 w-4" />}
    </button>
  );
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-3 px-3 pb-3 pt-5">
        <Link href="/home" aria-label={`${brand.systemName} home`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={brand.crestWhite} alt="" className="h-10 w-auto" />
        </Link>
        {toggle}
      </div>
    );
  }
  return (
    <div className="px-5 pt-6">
      <Link href="/home" className="block" aria-label={`${brand.systemName} home`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.logoWhite} alt={brand.institutionName} className="h-14 w-auto" />
      </Link>
      <div className="my-4 h-px bg-white/15" aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[0.9375rem] font-semibold leading-snug tracking-tight text-white">{brand.systemName}</span>
        {toggle}
      </div>
    </div>
  );
}

export function AppShell({ sections, unread, user, devBanner, brand, announcement, children }: {
  sections: NavSection[];
  brand: ShellBrand;
  announcement: { text: string; tone: "info" | "warning" } | null;
  unread: number;
  user: { name: string; email: string; roles: string[] };
  devBanner: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("pau.sidebar") === "collapsed");
    } catch {}
  }, []);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem("pau.sidebar", c ? "open" : "collapsed"); } catch {}
      return !c;
    });
  };

  const year = new Date().getFullYear();

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <a href="#main" className="skip-link">Skip to main content</a>

      {/* Desktop sidebar: full height, never scrolls with the page */}
      <aside className={`sidebar hidden shrink-0 flex-col transition-[width] duration-200 lg:flex ${collapsed ? "w-[4.75rem]" : "w-[16.5rem]"}`}>
        <Brand collapsed={collapsed} brand={brand} onToggle={toggle} />
        <NavList sections={sections} collapsed={collapsed} />
        <SidebarUser user={user} collapsed={collapsed} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobileOpen(false)} />
          <aside className="sidebar absolute inset-y-0 left-0 flex w-72 flex-col">
            <div className="flex items-start justify-between pr-2">
              <div className="min-w-0 flex-1"><Brand collapsed={false} brand={brand} /></div>
              <button onClick={() => setMobileOpen(false)} className="mt-4 rounded-md p-2 text-white hover:bg-white/10" aria-label="Close navigation"><X aria-hidden className="h-5 w-5" /></button>
            </div>
            <NavList sections={sections} collapsed={false} onNavigate={() => setMobileOpen(false)} />
            <SidebarUser user={user} collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {devBanner && (
          <div className="bg-amber-100 px-4 py-1 text-center text-xs font-medium text-warning-ink" role="note">
            Development environment: signed in with a fixture account. Data here is not real.
          </div>
        )}
        {announcement && (
          <div role="status" className={`px-4 py-2 text-center text-sm font-medium ${announcement.tone === "warning" ? "bg-amber-100 text-warning-ink" : "bg-brand-50 text-navy"}`}>
            {announcement.text}
          </div>
        )}
        <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-white px-4 sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-2 text-ink hover:bg-slate-100 lg:hidden" aria-label="Open navigation"><Menu aria-hidden className="h-5 w-5" /></button>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
            <HeaderSearch />
            <Link href="/notifications" className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-navy" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
              <Bell aria-hidden className="h-5 w-5" />
              {unread > 0 && <span className="tabular absolute right-0.5 top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
            </Link>
          </div>
        </header>
        <div className="relative flex-1 overflow-y-auto">
          <main id="main" className="mx-auto w-full max-w-[2200px] px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">{children}</main>
        </div>
        {/* Centred on the whole screen, not just the content column: the right padding matches the sidebar's width. */}
        <footer className={`app-footer shrink-0 px-4 py-1.5 text-center leading-tight transition-[padding] duration-200 sm:px-6 lg:pl-8 ${collapsed ? "lg:pr-[6.75rem]" : "lg:pr-[18.5rem]"}`}>
          <p className="text-[0.8125rem] font-semibold text-navy">&copy; {year} {brand.institutionName}. All rights reserved.</p>
          <p className="text-[0.8125rem] font-medium text-slate-700">{brand.systemName} v{brand.version}</p>
        </footer>
      </div>
    </div>
  );
}
