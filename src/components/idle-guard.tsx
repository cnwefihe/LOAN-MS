"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SHARED_KEY = "pau.lastActivity";
const WARNING_MS = 60_000;
const REPORT_EVERY_MS = 30_000;
// Deliberately not "scroll": pages can scroll themselves, and keys, wheel and touch already cover a person scrolling.
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/**
 * Signs the person out after the time set in Settings without activity, with one minute's warning.
 * Tabs share the last activity, so working in one keeps the others open. The server enforces the
 * same limit, so this cannot be bypassed; this is what clears the screen when nobody is there.
 */
export function IdleGuard({ minutes }: { minutes: number }) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const signOut = useRef<HTMLFormElement>(null);
  const lastActivity = useRef(0);
  const lastReport = useRef(0);
  const warning = useRef(false);

  const markActive = useCallback(() => {
    const now = Date.now();
    lastActivity.current = now;
    try { localStorage.setItem(SHARED_KEY, String(now)); } catch {}
    if (now - lastReport.current < REPORT_EVERY_MS) return;
    lastReport.current = now;
    fetch("/api/session/activity", { method: "POST" }).then((r) => {
      if (r.status === 401) window.location.assign("/login");
    }).catch(() => {});
  }, []);

  const stay = useCallback(() => {
    warning.current = false;
    setSecondsLeft(null);
    lastReport.current = 0;
    markActive();
  }, [markActive]);

  useEffect(() => {
    const onActivity = () => {
      // Once the warning shows, only "Stay signed in" counts: a passing mouse should not cancel it.
      if (!warning.current && Date.now() - lastActivity.current >= 1000) markActive();
    };
    const check = () => {
      let shared = 0;
      try { shared = Number(localStorage.getItem(SHARED_KEY)) || 0; } catch {}
      lastActivity.current = Math.max(lastActivity.current, shared);
      const left = minutes * 60_000 - (Date.now() - lastActivity.current);
      if (left <= 0) {
        clearInterval(timer);
        signOut.current?.submit();
      } else if (left <= WARNING_MS) {
        warning.current = true;
        setSecondsLeft(Math.ceil(left / 1000));
      } else if (warning.current) {
        // Another tab chose to stay signed in.
        warning.current = false;
        setSecondsLeft(null);
      }
    };
    // Loading the page already told the server the person is here.
    lastReport.current = Date.now();
    markActive();
    const timer = setInterval(check, 1000);
    ACTIVITY.forEach((e) => window.addEventListener(e, onActivity, { capture: true, passive: true }));
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      ACTIVITY.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
      document.removeEventListener("visibilitychange", check);
    };
  }, [minutes, markActive]);

  const open = secondsLeft !== null;
  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  return (
    <>
      <form ref={signOut} id="idle-sign-out" action="/api/auth/logout" method="post" hidden>
        <input type="hidden" name="reason" value="idle" />
      </form>
      <dialog ref={dialog} aria-labelledby="idle-title" aria-describedby="idle-text" onCancel={(e) => { e.preventDefault(); stay(); }}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-0 shadow-xl backdrop:bg-slate-900/40">
        <div className="p-6">
          <h2 id="idle-title" className="text-base font-semibold text-navy">Are you still there?</h2>
          <p id="idle-text" className="mt-2 text-sm text-ink">You have been inactive. You will be signed out in <span className="tabular font-semibold">{secondsLeft ?? 60} {secondsLeft === 1 ? "second" : "seconds"}</span>.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="submit" form="idle-sign-out" className="btn-secondary">Sign out</button>
            <button type="button" onClick={stay} className="btn-primary" autoFocus>Stay signed in</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
