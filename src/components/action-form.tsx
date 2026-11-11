"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";
import type { ActionResult } from "@/server/action-result";

type ServerAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/** How long a success notice stays on screen. */
const NOTICE_MS = 5000;

export interface Change { label: string; from: string; to: string }

/** The label a person sees for a form control. */
function labelOf(el: HTMLElement): string {
  const id = el.id;
  const byFor = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  const text = byFor?.textContent ?? el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? (el as HTMLInputElement).name;
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** What has been changed in a form since it was shown: each control's value against the value it started with. */
function changesIn(form: HTMLFormElement): Change[] {
  const out: Change[] = [];
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked !== el.defaultChecked && (el.type === "checkbox" || el.checked)) {
          out.push(el.type === "checkbox" ? { label: labelOf(el), from: el.defaultChecked ? "On" : "Off", to: el.checked ? "On" : "Off" } : { label: el.name, from: "", to: labelOf(el) });
        }
      } else if (el.type === "file") {
        if (el.files?.length) out.push({ label: labelOf(el), from: "", to: el.files[0].name });
      } else if (el.value !== el.defaultValue) out.push({ label: labelOf(el), from: el.defaultValue, to: el.value });
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) out.push({ label: labelOf(el), from: el.defaultValue, to: el.value });
    } else if (el instanceof HTMLSelectElement) {
      const was = Array.from(el.options).find((o) => o.defaultSelected) ?? el.options[0];
      const now = el.selectedOptions[0];
      if (was && now && was !== now) out.push({ label: labelOf(el), from: was.text, to: now.text });
    }
  }
  return out;
}

/** The changes, one per line: "Repayment day of the month: 25 → 26". */
export function ChangeList({ changes }: { changes: Change[] }) {
  if (!changes.length) return <p className="mt-2 text-sm text-muted">You have not changed anything.</p>;
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s || "(blank)");
  return (
    <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-line bg-slate-50 px-3 py-2 text-sm">
      {changes.map((c, i) => (
        <li key={i}><span className="font-medium text-ink">{c.label}</span>: {c.from ? <><span className="text-muted line-through">{cut(c.from)}</span> → </> : null}<span className="font-medium text-navy">{cut(c.to)}</span></li>
      ))}
    </ul>
  );
}

/**
 * Generic progressive-enhancement form for server actions: shows pending state, errors under the form,
 * a short success notice that clears itself, asks for confirmation in a dialog when `confirm` is set,
 * and follows redirects.
 */
export function ActionForm({
  action, children, submitLabel = "Save", variant = "primary", confirm, className, resetOnSuccess, hideSubmit, submitClassName, inline, listChanges, changes,
}: {
  inline?: boolean;
  action: ServerAction;
  children?: React.ReactNode;
  submitLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "success";
  /** Ask this question in a dialog before the action runs. */
  confirm?: string;
  /** List in the dialog what has been changed in the form (for forms whose fields start with their saved values). */
  listChanges?: boolean;
  /** The changes, worked out by the caller (for forms that keep their own values). */
  changes?: Change[];
  className?: string;
  resetOnSuccess?: boolean;
  hideSubmit?: boolean;
  submitClassName?: string;
  /** Accepted for clarity at the call site; React sets it for forms with an action function. */
  encType?: "multipart/form-data";
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const submitter = useRef<HTMLElement | null>(null);
  const msgId = useId();
  const titleId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const [found, setFound] = useState<Change[] | null>(null);

  useEffect(() => {
    if (!state) return;
    if (state.ok && state.redirectTo) router.push(state.redirectTo);
    else if (state.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      router.refresh();
    }
    setNotice(state.ok && state.message ? state.message : null);
  }, [state, router, resetOnSuccess]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const proceed = () => {
    confirmed.current = true;
    dialogRef.current?.close();
    formRef.current?.requestSubmit(submitter.current ?? undefined);
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      aria-describedby={state ? msgId : undefined}
      onSubmit={(e) => {
        if (confirm && !confirmed.current) {
          e.preventDefault();
          submitter.current = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
          setFound(changes ?? (listChanges && formRef.current ? changesIn(formRef.current) : null));
          dialogRef.current?.showModal();
          return;
        }
        confirmed.current = false;
      }}
    >
      {children}
      {state && !state.ok && (
        <div id={msgId} role="alert" className="mt-3 rounded-md border border-red-200 bg-danger-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </div>
      )}
      {notice && (
        <div id={msgId} role="status" className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2.5 rounded-lg border border-line bg-white px-4 py-3 text-sm text-ink shadow-lg">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-muted hover:text-ink" aria-label="Dismiss"><X aria-hidden className="h-4 w-4" /></button>
        </div>
      )}
      {!hideSubmit && (
        <div className={inline ? "inline-flex" : "mt-4 flex items-center gap-3"}>
          <button type="submit" disabled={pending} className={submitClassName ?? `btn-${variant}`}>
            {pending ? "Working…" : submitLabel}
          </button>
        </div>
      )}
      {confirm && (
        <dialog ref={dialogRef} aria-labelledby={titleId} data-confirm-dialog
          className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-0 text-left shadow-xl backdrop:bg-slate-900/40">
          <div className="px-5 pb-4 pt-5">
            <h2 id={titleId} className="text-base font-semibold text-navy">Please confirm</h2>
            <p className="mt-2 whitespace-normal text-sm text-slate-700">{confirm}</p>
            {found && <ChangeList changes={found} />}
          </div>
          <div className="flex justify-end gap-2 border-t border-line bg-slate-50 px-5 py-3">
            <button type="button" className="btn-secondary" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="button" className={variant === "danger" || submitClassName?.includes("danger") ? "btn-danger" : "btn-primary"} onClick={proceed}>Confirm</button>
          </div>
        </dialog>
      )}
    </form>
  );
}
