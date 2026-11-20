"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowRight, BookOpen, LifeBuoy, Lightbulb, Mail, Search, X } from "lucide-react";
import type { Guide } from "@/lib/assistant/guides";
import { guideMatchesPage } from "@/lib/assistant/guides";
import type { Answer, NextStep } from "@/server/services/assistant";
import { askAssistantAction, supportRequestAction } from "@/app/actions/assistant";
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

function GuideCard({ g, open }: { g: Guide; open?: boolean }) {
  return (
    <details className="group rounded-md border border-line bg-white" open={open}>
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 text-sm font-medium text-navy marker:hidden">
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

const TONE = { info: "border-sky-200 bg-sky-50", warning: "border-amber-200 bg-amber-50", success: "border-green-200 bg-green-50" } as const;

/**
 * The loan assistant: a Help button on every page that opens a panel with the person's next steps, tips for
 * the page they are on, answers to questions, every guide they may read, and a form to reach ICT support.
 * Guides and steps arrive already filtered for this person on the server.
 */
export function Assistant({ guides, steps, support, categories, firstName }: {
  guides: Guide[]; steps: NextStep[]; support: boolean; categories: readonly string[]; firstName: string;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("help");
  const [tip, setTip] = useState<Guide | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | { error: string } | null>(null);
  const [asking, startAsk] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const onPage = useMemo(() => guides.filter((g) => guideMatchesPage(g, path)), [guides, path]);
  const byArea = useMemo(() => {
    const m = new Map<string, Guide[]>();
    for (const g of guides) m.set(g.area, [...(m.get(g.area) ?? []), g]);
    return [...m.entries()];
  }, [guides]);
  const guideById = useMemo(() => new Map(guides.map((g) => [g.id, g])), [guides]);

  // Opened from elsewhere on the page (for example the dashboard card).
  useEffect(() => {
    const onOpen = (e: Event) => { setTab(((e as CustomEvent).detail as Tab) ?? "help"); setOpen(true); };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // The first visit to the dashboard opens the assistant once; the first visit to any other page with
  // tips shows a short hint beside the Help button.
  useEffect(() => {
    setTip(null);
    // Automated browsers (tests, screenshots) get no automatic opening or tips.
    if (navigator.webdriver) return;
    if ((path === "/dashboard" || path === "/home") && !store.get("assistant:welcomed")) {
      store.set("assistant:welcomed", "1");
      setTab("help");
      setOpen(true);
      return;
    }
    const first = onPage[0];
    if (!first) return;
    const key = `assistant:seen:${first.id}`;
    if (store.get(key)) return;
    store.set(key, "1");
    setTip(first);
    const t = window.setTimeout(() => setTip(null), 9000);
    return () => window.clearTimeout(t);
  }, [path, onPage]);

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
    setQuestion(text);
    startAsk(async () => setAnswer(await askAssistantAction(text)));
  };

  const suggestions = [
    ...(steps.length ? ["Where is my application?"] : []),
    ...(guides.some((g) => g.id === "apply") ? ["How do I apply?", "How much can I borrow?"] : []),
    ...(guides.some((g) => g.id === "repay") ? ["How do I repay early?"] : []),
    ...(guides.some((g) => g.id === "guarantee-respond") ? ["What does a guarantor do?"] : []),
  ].slice(0, 4);

  return (
    <>
      {/* Room at the foot of every page so the Help button never covers the last item. */}
      <div aria-hidden className="h-16 print:hidden" />
      {tip && !open && (
        <div role="status" className="fixed bottom-20 right-4 z-40 max-w-[18rem] rounded-lg border border-line bg-white p-3 text-sm shadow-lg print:hidden">
          <p className="flex items-start gap-2"><Lightbulb aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" /><span>Tips for this page: <strong className="font-medium text-navy">{tip.title}</strong></span></p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => setTip(null)}>Not now</button>
            <button type="button" className="btn-primary h-7 px-2 text-xs" onClick={() => { setTip(null); setTab("help"); setOpen(true); }}>Show me</button>
          </div>
        </div>
      )}

      <button ref={button} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="assistant-panel"
        className="fixed bottom-4 right-4 z-40 inline-flex h-11 items-center gap-2 rounded-full bg-brand px-4 text-sm font-medium text-white shadow-lg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 print:hidden">
        <LifeBuoy aria-hidden className="h-5 w-5" />Help
      </button>

      {open && (
        <div ref={panel} id="assistant-panel" role="dialog" aria-label="Loan assistant" tabIndex={-1}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-xl border border-line bg-slate-50 shadow-2xl outline-none sm:inset-x-auto sm:bottom-20 sm:right-4 sm:w-[26rem] sm:rounded-xl print:hidden">
          <div className="flex items-center justify-between gap-2 rounded-t-xl bg-navy px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Loan assistant</p>
              <p className="text-xs text-white/75">Hello {firstName}. How can I help?</p>
            </div>
            <button type="button" aria-label="Close" className="rounded p-1 hover:bg-white/10" onClick={() => { setOpen(false); button.current?.focus(); }}><X aria-hidden className="h-5 w-5" /></button>
          </div>
          <div role="tablist" aria-label="Assistant sections" className="flex border-b border-line bg-white text-sm">
            {([["help", "Help"], ["guides", "All guides"], ["contact", "Contact ICT"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`flex-1 px-3 py-2 ${tab === k ? "border-b-2 border-brand font-medium text-brand" : "text-muted hover:text-ink"}`}>{label}</button>
            ))}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {tab === "help" && (
              <>
                <form onSubmit={(e) => { e.preventDefault(); ask(input.current?.value ?? ""); }} className="flex gap-2">
                  <label htmlFor="assistant-question" className="sr-only">Ask a question</label>
                  <input ref={input} id="assistant-question" defaultValue={question} maxLength={300} placeholder="Ask a question, for example: how do I repay early?" className="input min-w-0 flex-1" autoComplete="off" />
                  <button type="submit" className="btn-primary px-3" aria-label="Ask" disabled={asking}><Search aria-hidden className="h-4 w-4" /></button>
                </form>
                {!answer && suggestions.length > 0 && (
                  <p className="flex flex-wrap gap-1.5">{suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => { if (input.current) input.current.value = s; ask(s); }} className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-navy hover:border-brand">{s}</button>
                  ))}</p>
                )}
                {asking && <p className="text-sm text-muted" role="status">Looking that up...</p>}
                {answer && !asking && (
                  <section aria-live="polite" className="space-y-2">
                    {"error" in answer ? <p className="text-sm text-red-800">{answer.error}</p> : (
                      <>
                        {answer.lines.length > 0 && (
                          <div className="space-y-1.5 rounded-md border border-line bg-white p-3 text-sm">{answer.lines.map((l, i) => <p key={i}>{l}</p>)}</div>
                        )}
                        {answer.links.length > 0 && <p className="flex flex-wrap gap-x-4">{answer.links.map((l) => <Link key={l.href} href={l.href} className="link text-sm">{l.label}</Link>)}</p>}
                        {answer.guides.map((id, i) => guideById.get(id) && <GuideCard key={id} g={guideById.get(id)!} open={i === 0} />)}
                        <p className="text-xs text-muted">Not what you needed? <button type="button" className="link" onClick={() => setTab("contact")}>Ask ICT support</button>.</p>
                      </>
                    )}
                  </section>
                )}

                {steps.length > 0 && (
                  <section>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Your next steps</h2>
                    <ul className="space-y-1.5">
                      {steps.map((s, i) => (
                        <li key={i} className={`rounded-md border px-3 py-2 text-sm ${TONE[s.tone ?? "info"]}`}>
                          {s.href ? <Link href={s.href} className="text-ink hover:underline">{s.text}</Link> : s.text}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {onPage.length > 0 && (
                  <section>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">On this page</h2>
                    <div className="space-y-2">{onPage.slice(0, 3).map((g, i) => <GuideCard key={g.id} g={g} open={i === 0 && !answer} />)}</div>
                  </section>
                )}
                {!onPage.length && !answer && (
                  <p className="text-sm text-muted">Ask a question above, or open All guides to see everything you can do.</p>
                )}
              </>
            )}

            {tab === "guides" && byArea.map(([area, list]) => (
              <section key={area}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{area}</h2>
                <div className="space-y-2">{list.map((g) => <GuideCard key={g.id} g={g} />)}</div>
              </section>
            ))}

            {tab === "contact" && (support ? (
              <section>
                <p className="mb-3 flex items-start gap-2 text-sm text-muted"><Mail aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />Tell ICT support what went wrong. They reply to your work email, and you get a copy of your request.</p>
                <ActionForm action={supportRequestAction} submitLabel="Send to ICT support" resetOnSuccess>
                  <input type="hidden" name="page" value={path} />
                  <label htmlFor="sr-category" className="label">Topic</label>
                  <select id="sr-category" name="category" className="input">{categories.map((c) => <option key={c}>{c}</option>)}</select>
                  <label htmlFor="sr-subject" className="label mt-3">Subject</label>
                  <input id="sr-subject" name="subject" required minLength={3} maxLength={120} className="input" />
                  <label htmlFor="sr-message" className="label mt-3">What happened?</label>
                  <textarea id="sr-message" name="message" required minLength={10} maxLength={4000} rows={5} className="input" placeholder="What you were doing, what you expected and what you saw." />
                  <p className="hint">The page you are on is included, so ICT can find the problem. Do not include passwords or codes.</p>
                </ActionForm>
              </section>
            ) : <p className="text-sm text-muted">ICT support has not been given an email address yet. Please contact ICT directly.</p>)}
          </div>
        </div>
      )}
    </>
  );
}
