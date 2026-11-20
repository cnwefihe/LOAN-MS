"use server";

import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { runAction, str } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { rateLimit } from "@/server/rate-limit";
import { answerQuestion, submitSupportRequest, type Answer } from "@/server/services/assistant";
import { getWording, roleTitles } from "@/server/wording";

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
    await rateLimit(`support:${actor.userId}`, 5, 3600);
    const db = await getDb();
    const ref = await submitSupportRequest(db, actor, {
      category: str(fd, "category"), subject: str(fd, "subject", true), message: str(fd, "message", true), page: str(fd, "page"),
      roles: roleTitles(await getWording(db), actor.roles),
    });
    return `Sent. Your reference is ${ref}. ICT support will reply by email; a copy is in your inbox.`;
  }, { limit: 10 });
}
