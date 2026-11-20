import { getDb } from "@/db";
import { publicGuides } from "@/lib/assistant/guides";
import { SIGN_IN_CATEGORIES, supportAvailable } from "@/server/services/assistant";
import { Assistant } from "./assistant";

/** The loan assistant on the sign-in pages: help with the security check, Microsoft sign-in and codes, and ICT support. */
export async function SignInAssistant() {
  return <Assistant signIn guideIds={publicGuides().map((g) => g.id)} support={await supportAvailable(await getDb())} categories={SIGN_IN_CATEGORIES} />;
}
