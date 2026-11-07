import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { homeFor } from "@/lib/nav";

/** After sign-in: HR, Accounts, approvers and administrators start in their work area; everyone else on their dashboard. */
export default async function Home() {
  const actor = await requireActor();
  redirect(await homeFor(await getDb(), actor));
}
