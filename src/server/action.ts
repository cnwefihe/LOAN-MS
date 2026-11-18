import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { LIST_COOKIE, parseMemory, resolveBack } from "@/lib/list-memory";
import { getActor } from "@/lib/auth/session";
import type { Actor } from "./actor";
import type { ActionResult } from "./action-result";
import { DomainError } from "./errors";
import { rateLimit } from "./rate-limit";
import { kickOutbox } from "./email";
import { parseMoneyInput } from "@/lib/finance/money";

type Done = void | string | { message?: string; redirectTo?: string };

/**
 * Wrap a server action: authenticate from the session, rate-limit mutations per user, map errors
 * to safe user-facing messages (never leaking internals), revalidate pages and dispatch queued email.
 */
export async function runAction(fn: (actor: Actor) => Promise<Done>, opts: { revalidate?: string[]; limit?: number } = {}): Promise<ActionResult> {
  const actor = await getActor();
  if (!actor) return { ok: false, error: "Your session has expired. Please sign in again." };
  let result: ActionResult;
  try {
    await rateLimit(`action:${actor.userId}`, opts.limit ?? 60, 60);
    const done = await fn(actor);
    (opts.revalidate ?? []).forEach((p) => revalidatePath(p, "layout"));
    kickOutbox();
    result = typeof done === "string" ? { ok: true, message: done } : { ok: true, ...(done ?? {}) };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
  // Redirect on the server (outside the try: redirect() works by throwing). Doing it client-side is
  // unreliable when the revalidated page no longer renders the submitting form.
  // A list is shown again at the page, search and filters last used there.
  if (result.ok && result.redirectTo) redirect(resolveBack(parseMemory((await cookies()).get(LIST_COOKIE)?.value), result.redirectTo));
  return result;
}

export function toMessage(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  // Malformed identifiers (e.g. a tampered id) are a client error, not a server fault.
  if (code === "22P02") return "That record could not be found.";
  if (code === "23505") return "This record already exists or was just submitted. Refresh the page to see the latest state.";
  if (code === "23000" || code === "23514") return `The database rejected this change: ${cause?.message ?? "integrity rule violated"}.`;
  if (code === "40001" || code === "40P01") return "Another user changed this record at the same time. Please try again.";
  console.error("[action] unexpected error", err);
  return "Something went wrong. The error has been logged; please try again or contact support.";
}

/* ───────── FormData helpers ───────── */

export function str(fd: FormData, key: string, required = false): string {
  const v = String(fd.get(key) ?? "").trim();
  if (required && !v) throw new DomainError(`${key.replace(/([A-Z])/g, " $1").toLowerCase()} is required.`);
  return v;
}

export function money(fd: FormData, key: string, label = key): string {
  const v = str(fd, key);
  if (!v) throw new DomainError(`Enter ${label}.`);
  try {
    return parseMoneyInput(v);
  } catch {
    throw new DomainError(`${label} must be a valid amount (e.g. 250000 or 250,000.00).`);
  }
}

export function int(fd: FormData, key: string, label = key): number {
  const v = Number(str(fd, key));
  if (!Number.isInteger(v)) throw new DomainError(`${label} must be a whole number.`);
  return v;
}

export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === "on" || v === "true" || v === "1";
}

export function dateStr(fd: FormData, key: string, label = key): string {
  const v = str(fd, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new DomainError(`Enter a valid ${label}.`);
  return v;
}

export function file(fd: FormData, key: string): File | null {
  const f = fd.get(key);
  return f instanceof File && f.size > 0 ? f : null;
}
