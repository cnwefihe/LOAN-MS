"use server";

import { headers } from "next/headers";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { runAction, str, toMessage } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { kickOutbox } from "@/server/email";
import { rateLimit } from "@/server/rate-limit";
import { answerQuestion, nextSteps, submitSignInSupportRequest, submitSupportRequest, type Answer, type NextStep } from "@/server/services/assistant";
import { getWording, roleTitles } from "@/server/wording";
import { getSettings } from "@/server/settings";

/** How many requests to ICT support each person or device may send, and over how long (Settings > Security). */
async function supportLimit() {
  const s = await getSettings(await getDb(), ["security.supportRequestsMax", "security.supportRequestsWindowMinutes"]);
  return { max: s["security.supportRequestsMax"], seconds: s["security.supportRequestsWindowMinutes"] * 60 };
}

/** The signed-in person's own next steps: their applications, guarantees and next deduction. */
export async function nextStepsAction(): Promise<NextStep[]> {
  const actor = await getActor();
  if (!actor) return [];
  return nextSteps(await getDb(), actor);
}

/** An answer for the signed-in person only, from their own records and the guides they may read. */
export async function askAssistantAction(question: string): Promise<Answer | { error: string }> {
  const actor = await getActor();
  if (!actor) return { error: "Your session has expired. Please sign in again." };
  try {
    await rateLimit(`assistant:${actor.userId}`, 60, 300);
  } catch {
    return { error: "Too many questions in a short time. Please wait a moment." };
  }
  return answerQuestion(await getDb(), actor, String(question ?? ""));
}

export async function supportRequestAction(_: ActionResult | null, fd: FormData) {
  return runAction(async (actor) => {
    const limit = await supportLimit();
    await rateLimit(`support:${actor.userId}`, limit.max, limit.seconds);
    const db = await getDb();
    const ref = await submitSupportRequest(db, actor, {
      category: str(fd, "category"), subject: str(fd, "subject", true), message: str(fd, "message", true), page: str(fd, "page"),
      roles: roleTitles(await getWording(db), actor.roles),
    });
    return `Sent. Your reference is ${ref}. ICT support will reply by email; a copy is in your inbox.`;
  }, { limit: 10 });
}

/** From the sign-in pages, for someone who cannot sign in. Limited per device and per email address. */
export async function signInSupportRequestAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  // A field people never see: automated form-fillers complete it and are quietly ignored.
  if (str(fd, "website")) return { ok: true, message: "Sent." };
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0].trim() || "local";
  try {
    const limit = await supportLimit();
    await rateLimit(`support-public:${str(fd, "email").toLowerCase()}`, limit.max, limit.seconds);
    const ref = await submitSignInSupportRequest(await getDb(), {
      name: str(fd, "name", true), email: str(fd, "email", true), category: str(fd, "category"),
      subject: str(fd, "subject", true), message: str(fd, "message", true), page: str(fd, "page"), ip,
    });
    kickOutbox();
    return { ok: true, message: `Sent. Your reference is ${ref}. ICT support will reply to your email; a copy is in your inbox.` };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
