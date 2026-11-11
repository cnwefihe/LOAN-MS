"use server";

import { getDb } from "@/db";
import { runAction, str, bool } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { importGuarantors, removeGuarantorEntry, saveGuarantorEntry } from "@/server/services/guarantor-pool";

type Prev = ActionResult | null;
const PATHS = ["/admin/guarantors", "/applications"];

export async function saveGuarantorEntryAction(id: string | null, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await saveGuarantorEntry(await getDb(), actor, {
      id: id ?? undefined, name: str(fd, "name", true), email: str(fd, "email", true), cadre: str(fd, "cadre"),
      isActive: id ? bool(fd, "isActive") : true,
    });
    return id ? { message: "Guarantor saved.", redirectTo: "/admin/guarantors" } : "Guarantor added.";
  }, { revalidate: PATHS });
}

export async function removeGuarantorEntryAction(id: string, _: Prev) {
  return runAction(async (actor) => {
    await removeGuarantorEntry(await getDb(), actor, id);
    return { message: "Guarantor removed from the list.", redirectTo: "/admin/guarantors" };
  }, { revalidate: PATHS });
}

export async function importGuarantorsAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const r = await importGuarantors(await getDb(), actor, str(fd, "lines", true), str(fd, "cadre") || "Managerial");
    const parts = [`${r.added} added`, `${r.updated} updated`];
    const skipped = r.skipped.length ? ` These lines could not be read: ${r.skipped.slice(0, 5).join("; ")}${r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ""}.` : "";
    return `${parts.join(", ")}.${skipped}`;
  }, { revalidate: PATHS });
}
