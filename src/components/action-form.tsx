"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/server/action-result";

type ServerAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Generic progressive-enhancement form for server actions: shows pending state, field-level
 * error summary and success messages, confirms destructive actions, and follows redirects.
 */
export function ActionForm({
  action, children, submitLabel = "Save", variant = "primary", confirm, className, resetOnSuccess, hideSubmit, submitClassName, inline,
}: {
  inline?: boolean;
  action: ServerAction;
  children?: React.ReactNode;
  submitLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "success";
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
  const msgId = useId();

  useEffect(() => {
    if (!state) return;
    if (state.ok && state.redirectTo) router.push(state.redirectTo);
    else if (state.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      router.refresh();
    }
  }, [state, router, resetOnSuccess]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      aria-describedby={state ? msgId : undefined}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state && !state.ok && (
        <div id={msgId} role="alert" className="mt-3 rounded-md border border-red-200 bg-danger-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </div>
      )}
      {state?.ok && state.message && (
        <div id={msgId} role="status" className="mt-3 rounded-md border border-green-200 bg-success-50 px-3 py-2 text-sm text-green-900">
          {state.message}
        </div>
      )}
      {!hideSubmit && (
        <div className={inline ? "inline-flex" : "mt-4 flex items-center gap-3"}>
          <button type="submit" disabled={pending} className={submitClassName ?? `btn-${variant}`}>
            {pending ? "Working…" : submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}
