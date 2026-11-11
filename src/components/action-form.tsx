"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";
import type { ActionResult } from "@/server/action-result";

type ServerAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/** How long a success notice stays on screen. */
const NOTICE_MS = 5000;

/**
 * Generic progressive-enhancement form for server actions: shows pending state, errors under the form,
 * a short success notice that clears itself, asks for confirmation in a dialog when `confirm` is set,
 * and follows redirects.
 */
export function ActionForm({
  action, children, submitLabel = "Save", variant = "primary", confirm, className, resetOnSuccess, hideSubmit, submitClassName, inline,
}: {
  inline?: boolean;
  action: ServerAction;
  children?: React.ReactNode;
  submitLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "success";
  /** Ask this question in a dialog before the action runs. */
  confirm?: string;
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
