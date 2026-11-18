"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Clock, ShieldCheck, X } from "lucide-react";

interface Challenge { token: string; background: string; piece: string; pieceY: number; width: number; height: number; pieceSize: number; offset: number; devAnswer?: number }
type Trail = [number, number, number][];
type State = "loading" | "ready" | "checking" | "passed" | "failed" | "locked" | "error";

/**
 * Security verification shown before the sign-in buttons: drag the slider so the piece fits its place in the image.
 * Also works by tapping the track where the gap is, or with the arrow keys and Enter.
 */
export function HumanCheck() {
  const router = useRouter();
  const [c, setC] = useState<Challenge | null>(null);
  const [pos, setPos] = useState(0);
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState("");
  const trail = useRef<Trail>([]);
  const start = useRef(0);
  const dragging = useRef(false);
  const grab = useRef(0); // where on the handle the pointer took hold
  const track = useRef<HTMLDivElement>(null);
  const [wait, setWait] = useState(0); // seconds left while this device is locked out

  const load = useCallback(async (note = "") => {
    setState("loading");
    setPos(0);
    trail.current = [];
    try {
      const res = await fetch("/api/human/challenge", { cache: "no-store" });
      const data = await res.json();
      if (res.status === 423 && data.retryAfter) { setC(null); setWait(data.retryAfter); setState("locked"); setMessage(data.error); return; }
      if (!res.ok) { setState("error"); setMessage(data.error ?? "Verification is unavailable. Please try again in a moment."); return; }
      setC(data);
      setState("ready");
      setMessage(note);
    } catch {
      setState("error");
      setMessage("Verification could not load. Please check your connection and try again.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While locked, count down and offer a new image when the time is up.
  useEffect(() => {
    if (state !== "locked") return;
    if (wait <= 0) { void load(); return; }
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [state, wait, load]);

  const max = c ? c.width - c.pieceSize : 0;
  const clamp = (v: number) => Math.max(0, Math.min(max, v));
  const note = (x: number, y: number) => {
    const t = performance.now();
    if (!trail.current.length) start.current = t;
    trail.current.push([Math.round(t - start.current), Math.round(x), Math.round(y)]);
  };

  async function submit(at: number, method: "pointer" | "keyboard") {
    if (!c) return;
    setState("checking");
    try {
      const res = await fetch("/api/human/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: c.token, x: at + c.offset, trail: trail.current, method }) });
      const data = await res.json();
      if (data.ok) {
        setState("passed");
        setMessage("Verification successful.");
        router.refresh();
        return;
      }
      if (data.retryAfter) { setC(null); setWait(data.retryAfter); setState("locked"); setMessage(data.message); return; }
      // Show the failure briefly, then a fresh image to try again.
      const msg = data.message ?? "Verification failed. Please try again.";
      setState("failed");
      setMessage(msg);
      setTimeout(() => void load(msg), 700);
    } catch {
      await load("Verification failed. Please try again.");
    }
  }

  const fromPointer = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    const scale = c!.width / box.width;
    return clamp((clientX - box.left) * scale - grab.current);
  };

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (state !== "ready" || !c) return;
    const box = track.current!.getBoundingClientRect();
    const scale = c.width / box.width;
    const at = (e.clientX - box.left) * scale;
    // On the handle: hold it where it was taken. Elsewhere on the track: the handle centres there.
    grab.current = at >= pos && at <= pos + c.pieceSize ? at - pos : c.pieceSize / 2;
    dragging.current = true;
    trail.current = [];
    e.currentTarget.setPointerCapture(e.pointerId);
    note(e.clientX, e.clientY);
    setPos(fromPointer(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    note(e.clientX, e.clientY);
    setPos(fromPointer(e.clientX));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    note(e.clientX, e.clientY);
    const at = fromPointer(e.clientX);
    setPos(at);
    void submit(at, "pointer");
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (state !== "ready") return;
    const step = e.shiftKey ? 10 : 2;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = pos + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = pos - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); note(pos, 0); void submit(pos, "keyboard"); return; }
    if (next === null) return;
    e.preventDefault();
    const v = clamp(next);
    note(v, 0);
    setPos(v);
  }

  const busy = state === "loading" || state === "checking" || state === "failed" || state === "locked";
  const tone = state === "passed" ? "bg-success text-white" : state === "failed" ? "bg-slate-200 text-slate-600" : "bg-navy text-white";
  return (
    <section aria-labelledby="human-title" className="mt-7 rounded-lg border border-line bg-white">
      <header className="border-b border-line px-3 py-2.5">
        <h2 id="human-title" className="flex items-center gap-1.5 text-sm font-semibold text-navy"><ShieldCheck aria-hidden className="h-4 w-4 text-brand" />Security verification</h2>
      </header>
      <div className="p-3">
        <p id="human-help" className="text-xs text-slate-700">Drag the slider to fit the piece into its place.<span className="sr-only"> You can also use the arrow keys, then press Enter.</span></p>

        <div className="relative mt-2.5 w-full overflow-hidden rounded-md bg-slate-100" style={{ aspectRatio: c ? `${c.width} / ${c.height}` : "300 / 160" }}>
          {c && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.background} alt="Verification image" className="absolute inset-0 h-full w-full select-none" draggable={false} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.piece} alt="" aria-hidden draggable={false} className="pointer-events-none absolute select-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.45)]"
                style={{ left: `${(pos / c.width) * 100}%`, top: `${(c.pieceY / c.height) * 100}%`, width: `${(c.pieceSize / c.width) * 100}%` }} />
            </>
          )}
          {state === "loading" && <div aria-hidden className="absolute inset-0 animate-pulse bg-slate-200" />}
          {state === "passed" && <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-success py-1.5 text-xs font-semibold text-white"><Check aria-hidden className="h-4 w-4" />Verified</div>}
          {state === "failed" && <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-white/85 py-1 text-xs font-medium text-red-800"><X aria-hidden strokeWidth={2.5} className="h-3 w-3" />Try again</div>}
          {state === "locked" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-slate-50 px-4 text-center">
              <Clock aria-hidden className="h-6 w-6 text-muted" />
              <p className="text-sm font-semibold text-navy">Temporarily locked</p>
              <p className="text-xs text-muted">Try again in <span className="tabular font-medium text-ink">{Math.floor(wait / 60)}:{String(wait % 60).padStart(2, "0")}</span></p>
            </div>
          )}
        </div>

        <div ref={track} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { dragging.current = false; }}
          className="relative mt-2.5 h-10 w-full touch-none select-none overflow-hidden rounded-md border border-line bg-slate-50">
          {c && <span aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 ${state === "passed" ? "bg-success-50" : state === "failed" ? "bg-slate-100" : "bg-brand-50"}`} style={{ width: `${((pos + c.pieceSize / 2) / c.width) * 100}%` }} />}
          {pos < 4 && state === "ready" && <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center pl-10 text-xs font-medium text-muted">Drag to verify</span>}
          {c && (
            <div role="slider" tabIndex={0} aria-label="Verification slider" aria-describedby="human-help" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(pos)} aria-disabled={busy || undefined}
              onKeyDown={onKeyDown}
              className={`absolute top-0 flex h-full cursor-grab items-center justify-center rounded-md shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:cursor-grabbing ${tone}`}
              style={{ left: `${(pos / c.width) * 100}%`, width: `${(c.pieceSize / c.width) * 100}%` }}>
              {state === "passed" ? <Check aria-hidden className="h-5 w-5" /> : state === "failed" ? <X aria-hidden strokeWidth={2.5} className="h-3.5 w-3.5" /> : <ArrowRight aria-hidden className="h-5 w-5" />}
            </div>
          )}
        </div>
        <p role="status" aria-live="polite" className={`mt-2 min-h-4 text-xs ${state === "passed" ? "text-green-800" : state === "failed" || state === "error" || state === "locked" ? "text-red-800" : "text-muted"}`}>
          {state === "checking" ? "Verifying..." : state === "loading" && !message ? "Loading..." : message}
        </p>
      </div>
      {c?.devAnswer !== undefined && <span hidden data-testid="dev-human-answer">{c.devAnswer - c.offset}</span>}
    </section>
  );
}
