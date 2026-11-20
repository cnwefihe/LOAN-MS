"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowRight, BookOpen, ListChecks, LifeBuoy, Lightbulb, Mail, MapPin, Search, X } from "lucide-react";
import type { Guide } from "@/lib/assistant/guides";
import { guideMatchesPage, searchGuides } from "@/lib/assistant/guides";
import type { Answer, NextStep } from "@/server/services/assistant";
import { askAssistantAction, signInSupportRequestAction, supportRequestAction } from "@/app/actions/assistant";
import { ActionForm } from "@/components/action-form";

const OPEN_EVENT = "open-assistant";
type Tab = "help" | "guides" | "contact";

const store = {
  get(key: string) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, v: string) { try { window.localStorage.setItem(key, v); } catch { /* private window: fine */ } },
};

/** A button anywhere on a page that opens the assistant. */
export function OpenAssistantButton({ children, className = "btn-secondary", tab = "help" }: { children: React.ReactNode; className?: string; tab?: Tab }) {
  return <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: tab }))}>{children}</button>;
}

/** Opening one item in the assistant closes the others, so the list stays short. */
function onlyOneOpen(e: React.SyntheticEvent<HTMLDetailsElement>) {
  const opened = e.currentTarget;
  if (!opened.open) return;
  opened.closest("[role=dialog]")?.querySelectorAll<HTMLDetailsElement>("details[data-assistant-item]").forEach((d) => { if (d !== opened && d.open) d.open = false; });
}

/** One guide: its title folds out to the summary, the steps and any links. */
function GuideCard({ g, open, highlight }: { g: Guide; open?: boolean; highlight?: boolean }) {
  return (
    <details data-assistant-item onToggle={onlyOneOpen} className={`group rounded-md border bg-white ${highlight ? "border-brand/40" : "border-line"}`} open={open}>
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 text-sm font-medium text-navy marker:hidden [&::-webkit-details-marker]:hidden">
        <BookOpen aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <span className="flex-1">{g.title}</span>
        <ArrowRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-line px-3 py-3 text-sm">
        <p className="text-muted">{g.summary}</p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink">
          {g.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        {g.links?.length ? (
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{g.links.map((l) => <Link key={l.href} href={l.href} className="link text-sm">{l.label}</Link>)}</p>
        ) : null}
      </div>
    </details>
  );
}

function Heading({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Icon aria-hidden className="h-3.5 w-3.5" />{children}</h2>;
}

const TONE = { info: "border-sky-200 bg-sky-50", warning: "border-amber-200 bg-amber-50", success: "border-green-200 bg-green-50" } as const;

/**
 * The loan assistant: a Help button on every page. It always opens on the page the person is on, with that
 * page's guide unfolded first; everything else stays folded until asked for. It also answers questions,
 * lists the person's next steps and every guide they may read, and sends requests to ICT support.
 * Guides and steps arrive already filtered for this person on the server.
 */
export function Assistant({ guides, steps, support, categories, firstName, signIn = false }: {
  guides: Guide[]; steps: NextStep[]; support: boolean; categories: readonly string[]; firstName?: string;
  /** On the sign-in pages: sign-in help only, answers from the guides, and a support form that asks who you are. */
  signIn?: boolean;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("help");
  const [tip, setTip] = useState<Guide | null>(null);
  const [answer, setAnswer] = useState<Answer | { error: string } | null>(null);
  const [asking, startAsk] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const onPage = useMemo(() => guides.filter((g) => guideMatchesPage(g, path)), [guides, path]);
  // All guides, with the areas of this page first.
  const byArea = useMemo(() => {
    const m = new Map<string, Guide[]>();
    for (const g of guides) m.set(g.area, [...(m.get(g.area) ?? []), g]);
    const here = new Set<string>(onPage.map((g) => g.area));
    return [...m.entries()].sort(([a], [b]) => Number(here.has(b)) - Number(here.has(a)));
  }, [guides, onPage]);
  const guideById = useMemo(() => new Map(guides.map((g) => [g.id, g])), [guides]);

  // Moving to another page starts afresh on that page: its guide first, the last answer cleared.
  useEffect(() => {
    setAnswer(null);
    setTab("help");
    if (input.current) input.current.value = "";
    body.current?.scrollTo({ top: 0 });
  }, [path]);

  // Opened from elsewhere on the page (for example the dashboard strip).
  useEffect(() => {
    const onOpen = (e: Event) => { setTab(((e as CustomEvent).detail as Tab) ?? "help"); setOpen(true); };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // The first visit to the dashboard opens the assistant once; the first visit to any other page with a
  // guide shows a short hint beside the Help button.
  useEffect(() => {
    setTip(null);
    // Automated browsers (tests, screenshots) get no automatic opening or hints.
    if (navigator.webdriver) return;
    if ((path === "/dashboard" || path === "/home") && !store.get("assistant:welcomed")) {
      store.set("assistant:welcomed", "1");
      setOpen(true);
      return;
    }
    const first = onPage[0];
    if (!first || open) return;
    const key = `assistant:seen:${first.id}`;
    if (store.get(key)) return;
    store.set(key, "1");
    setTip(first);
    const t = window.setTimeout(() => setTip(null), 9000);
    return () => window.clearTimeout(t);
  }, [path, onPage, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text) return;
    // Before signing in there are no records to read: the answer comes from the sign-in guides alone.
    if (signIn) { setAnswer({ lines: [], links: [], guides: searchGuides(guides, text).map((g) => g.id) }); return; }
    startAsk(async () => setAnswer(await askAssistantAction(text)));
  };

  const suggestions = signIn ? ["The slider piece will not fit", "My code is refused", "I lost my phone", "How do I set up the code?"] : [
    ...(steps.length ? ["Where is my application?"] : []),
    ...(guides.some((g) => g.id === "apply") ? ["How do I apply?", "How much can I borrow?"] : []),
    ...(guides.some((g) => g.id === "repay-early") ? ["How do I repay early?"] : []),
    ...(guides.some((g) => g.id === "guarantee-obligation") ? ["What does a guarantor do?"] : []),
  ].slice(0, 4);

  return (
    <>
      {tip && !open && (
        <div role="status" className="fixed bottom-[6.25rem] right-4 z-40 max-w-[18rem] rounded-lg border border-line bg-white p-3 text-sm shadow-lg print:hidden">
          <p className="flex items-start gap-2"><Lightbulb aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" /><span>Help for this page: <strong className="font-medium text-navy">{tip.title}</strong></span></p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => setTip(null)}>Not now</button>
            <button type="button" className="btn-primary h-7 px-2 text-xs" onClick={() => { setTip(null); setTab("help"); setOpen(true); }}>Show me</button>
          </div>
        </div>
      )}

      <button ref={button} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="assistant-panel"
        className="fixed bottom-[3.75rem] right-4 z-40 inline-flex h-8 items-center gap-1.5 rounded-full bg-brand px-3 text-xs font-medium text-white shadow-md ring-2 ring-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 print:hidden">
        <LifeBuoy aria-hidden className="h-3.5 w-3.5" />Help
      </button>

      {open && (
        <div ref={panel} id="assistant-panel" role="dialog" aria-label="Loan assistant" tabIndex={-1}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[calc(100vh-8rem)] flex-col rounded-t-xl border border-line bg-slate-50 shadow-2xl outline-none sm:inset-x-auto sm:bottom-[6.25rem] sm:right-4 sm:w-[26rem] sm:rounded-xl print:hidden">
          <div className="flex items-center justify-between gap-2 rounded-t-xl bg-navy px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Loan assistant</p>
              <p className="text-xs text-white/75">{signIn ? "Help with signing in, or contact ICT support." : `Hello ${firstName}. Here is help for the page you are on.`}</p>
            </div>
            <button type="button" aria-label="Close" className="rounded p-1 hover:bg-white/10" onClick={() => { setOpen(false); button.current?.focus(); }}><X aria-hidden className="h-5 w-5" /></button>
          </div>
          <div role="tablist" aria-label="Assistant sections" className="flex border-b border-line bg-white text-sm">
            {((signIn ? [["help", "This page"], ["contact", "Contact ICT"]] : [["help", "This page"], ["guides", "All guides"], ["contact", "Contact ICT"]]) as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`flex-1 px-3 py-2 ${tab === k ? "border-b-2 border-brand font-medium text-brand" : "text-muted hover:text-ink"}`}>{label}</button>
            ))}
          </div>

          <div ref={body} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {tab === "help" && (
              // Keyed by page, so moving to another page folds everything that was open on the last one.
              <div key={path} className="space-y-4">
                <section>
                  <Heading icon={MapPin}>On this page</Heading>
                  {onPage.length ? (
                    <div className="space-y-2">{onPage.slice(0, 3).map((g, i) => <GuideCard key={g.id} g={g} open={i === 0} highlight={i === 0} />)}</div>
                  ) : (
                    <p className="rounded-md border border-line bg-white px-3 py-2.5 text-sm text-muted">This page has no guide of its own. Ask below, or open All guides.</p>
                  )}
                </section>

                <section>
                  <Heading icon={Search}>Ask a question</Heading>
                  <form onSubmit={(e) => { e.preventDefault(); ask(input.current?.value ?? ""); }} className="flex gap-2">
                    <label htmlFor="assistant-question" className="sr-only">Ask a question</label>
                    <input ref={input} id="assistant-question" maxLength={300} placeholder={signIn ? "For example: my code is refused" : "For example: how do I repay early?"} className="input min-w-0 flex-1" autoComplete="off" />
                    <button type="submit" className="btn-primary px-3" aria-label="Ask" disabled={asking}><Search aria-hidden className="h-4 w-4" /></button>
                  </form>
                  {!answer && !asking && suggestions.length > 0 && (
                    <p className="mt-2 flex flex-wrap gap-1.5">{suggestions.map((s) => (
                      <button key={s} type="button" onClick={() => { if (input.current) input.current.value = s; ask(s); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-navy hover:border-brand">{s}</button>
                    ))}</p>
                  )}
                  {asking && <p className="mt-2 text-sm text-muted" role="status">Looking that up...</p>}
                  {answer && !asking && (
                    <div aria-live="polite" className="mt-2 space-y-2">
                      {"error" in answer ? <p className="text-sm text-red-800">{answer.error}</p> : (
                        <>
                          {signIn && !answer.guides.length && <p className="rounded-md border border-line bg-white p-3 text-sm">I could not find help for that. Try other words, or send a request to ICT support.</p>}
                          {answer.lines.length > 0 && <div className="space-y-1.5 rounded-md border border-line bg-white p-3 text-sm">{answer.lines.map((l, i) => <p key={i}>{l}</p>)}</div>}
                          {answer.links.length > 0 && <p className="flex flex-wrap gap-x-4">{answer.links.map((l) => <Link key={l.href} href={l.href} className="link text-sm">{l.label}</Link>)}</p>}
                          {answer.guides.filter((id) => guideById.has(id)).map((id, i) => <GuideCard key={id} g={guideById.get(id)!} open={i === 0 && !answer.lines.length} />)}
                          <p className="text-xs text-muted">Not what you needed? <button type="button" className="link" onClick={() => setTab("contact")}>Contact ICT support</button>.</p>
                        </>
                      )}
                    </div>
                  )}
                </section>

                {steps.length > 0 && (
                  <details data-assistant-item onToggle={onlyOneOpen} className="group rounded-md border border-line bg-white">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-navy [&::-webkit-details-marker]:hidden">
                      <ListChecks aria-hidden className="h-4 w-4 shrink-0 text-brand" />
                      <span className="flex-1">Your next steps</span>
                      <span className="tabular rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-warning-ink">{steps.length}</span>
                      <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90" />
                    </summary>
                    <ul className="space-y-1.5 border-t border-line p-3">
                      {steps.map((s, i) => (
                        <li key={i} className={`rounded-md border px-3 py-2 text-sm ${TONE[s.tone ?? "info"]}`}>
                          {s.href ? <Link href={s.href} className="text-ink hover:underline">{s.text}</Link> : s.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {tab === "guides" && byArea.map(([area, list]) => (
              <section key={area}>
                <Heading icon={BookOpen}>{area}</Heading>
                <div className="space-y-2">{list.map((g) => <GuideCard key={g.id} g={g} highlight={onPage.includes(g)} />)}</div>
              </section>
            ))}

            {tab === "contact" && (support ? (
              <section>
                <p className="mb-3 flex items-start gap-2 text-sm text-muted"><Mail aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{signIn ? "Cannot sign in? Tell ICT support what happens. They reply to your email, and you get a copy." : "Tell ICT support what went wrong. They reply to your email, and you get a copy of your request."}</p>
                <ActionForm action={signIn ? signInSupportRequestAction : supportRequestAction} submitLabel="Send" submitClassName="btn-primary h-8 px-4 text-xs" resetOnSuccess>
                  <input type="hidden" name="page" value={path} />
                  {signIn && (
                    <>
                      <label htmlFor="sr-name" className="label">Name</label>
                      <input id="sr-name" name="name" required minLength={2} maxLength={120} autoComplete="name" className="input" />
                      <label htmlFor="sr-email" className="label mt-3">Email</label>
                      <input id="sr-email" name="email" type="email" required maxLength={254} autoComplete="email" className="input" />
                      {/* Left empty by people; filled only by automated form-fillers. */}
                      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden"><label htmlFor="sr-website">Website</label><input id="sr-website" name="website" tabIndex={-1} autoComplete="off" /></div>
                    </>
                  )}
                  <label htmlFor="sr-category" className={signIn ? "label mt-3" : "label"}>Topic</label>
                  <select id="sr-category" name="category" className="input">{categories.map((c) => <option key={c}>{c}</option>)}</select>
                  <label htmlFor="sr-subject" className="label mt-3">Subject</label>
                  <input id="sr-subject" name="subject" required minLength={3} maxLength={120} className="input" />
                  <label htmlFor="sr-message" className="label mt-3">What happened?</label>
                  <textarea id="sr-message" name="message" required minLength={10} maxLength={4000} rows={4} className="input" placeholder="What you were doing, what you expected and what you saw." />
                  <p className="hint">The page you are on is included, so ICT can find the problem. Never include passwords or codes.</p>
                </ActionForm>
              </section>
            ) : <p className="text-sm text-muted">ICT support has not been given an email address yet. Please contact ICT directly.</p>)}
          </div>
        </div>
      )}
    </>
  );
}
