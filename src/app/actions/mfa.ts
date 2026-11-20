"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSignInState } from "@/lib/auth/session";
import { toMessage } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { rateLimit } from "@/server/rate-limit";
import { withCodeLock } from "@/server/code-lock";
import { confirmEnrolment, verifySecondStep } from "@/server/services/mfa";

/** Runs a second-step action for the signed-in (but not yet verified) person, then goes to the dashboard. */
async function secondStep(fd: FormData, fn: (userId: string, sessionId: string, code: string) => Promise<void>): Promise<ActionResult> {
  const state = await getSignInState();
  if (!state) return { ok: false, error: "Your session has expired. Please sign in again." };
  try {
    await rateLimit(`mfa:${state.actor.userId}`, 30, 300); // a backstop; wrong codes lock the account (Settings > Security)
    const db = await getDb();
    await withCodeLock(db, state.actor.userId, () => fn(state.actor.userId, state.sessionId, String(fd.get("code") ?? "")));
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
  redirect("/home");
}

export async function confirmMfaSetupAction(_: ActionResult | null, fd: FormData) {
  return secondStep(fd, async (u, s, c) => confirmEnrolment(await getDb(), u, s, c));
}

export async function verifyMfaAction(_: ActionResult | null, fd: FormData) {
  return secondStep(fd, async (u, s, c) => verifySecondStep(await getDb(), u, s, c));
}
