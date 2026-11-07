"use server";

import { getDb } from "@/db";
import { runAction, file } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { DomainError } from "@/server/errors";
import { verifyFile } from "@/server/services/verification";

export async function verifyDocumentAction(_: ActionResult | null, fd: FormData) {
  return runAction(async (actor) => {
    const f = file(fd, "document");
    if (!f) throw new DomainError("Choose the PDF to check.");
    if (f.size > 25 * 1024 * 1024) throw new DomainError("That file is too large to be a document issued by this system.");
    const r = await verifyFile(await getDb(), actor, Buffer.from(await f.arrayBuffer()));
    return { redirectTo: `/verify?sha=${r.sha}&name=${encodeURIComponent(f.name.slice(0, 120))}` };
  }, { limit: 20 });
}
