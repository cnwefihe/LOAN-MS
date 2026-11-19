"use server";

import { getDb } from "@/db";
import { bool, file, runAction, str } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import type { Actor } from "@/server/actor";
import { assertCan } from "@/server/actor";
import { DomainError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { confirmWithCode } from "@/server/services/mfa";
import { deleteStaffRecord, importStaffRecords, saveStaffRecord } from "@/server/services/staff-records";
import { closeRecords, openRecords, recordsOpen } from "@/server/records-unlock";

type Prev = ActionResult | null;
const PAGE = "/admin/register";
const PATHS = [PAGE, "/profile", "/eligibility", "/hr"];

async function mustBeOpen(actor: Actor) {
  if (!(await recordsOpen(await getDb(), actor.userId))) throw new DomainError("The Register has closed after a period without activity. Enter your two-step verification code to open it again.");
}

export async function openStaffRecordsAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    assertCan(actor, "register.view");
    await rateLimit(`records-open:${actor.userId}`, 8, 300);
    await confirmWithCode(await getDb(), actor, str(fd, "code", true), "open the Register");
    await openRecords(await getDb(), actor.userId);
    return { redirectTo: PAGE };
  }, { revalidate: [PAGE] });
}

export async function closeStaffRecordsAction() {
  return runAction(async (actor) => {
    await closeRecords(await getDb(), actor.userId);
    return { redirectTo: PAGE };
  });
}

export async function importStaffRecordsAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await mustBeOpen(actor);
    const f = file(fd, "sheet");
    if (!f) throw new DomainError("Choose the spreadsheet to upload.");
    if (f.size > 5 * 1024 * 1024) throw new DomainError("The file is larger than 5 MB.");
    const r = await importStaffRecords(await getDb(), actor, { buffer: Buffer.from(await f.arrayBuffer()), name: f.name });
    const skipped = r.skipped.length ? ` Not saved: ${r.skipped.slice(0, 6).map((s) => `row ${s.row} (${s.reason})`).join("; ")}${r.skipped.length > 6 ? ` and ${r.skipped.length - 6} more` : ""}.` : "";
    const dates = r.monthFirst ? " Excel had saved the dates month first (US setting); they were read back as day, month, year." : "";
    return `${r.added} added, ${r.updated} updated; ${r.linked} profiles filled.${dates}${skipped}`;
  }, { revalidate: PATHS });
}

export async function saveStaffRecordAction(id: string | null, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await mustBeOpen(actor);
    await saveStaffRecord(await getDb(), actor, {
      id: id ?? undefined, employeeCode: str(fd, "employeeCode", true), email: str(fd, "email") || null, payGrade: str(fd, "payGrade", true),
      employmentDate: str(fd, "employmentDate", true), confirmed: bool(fd, "confirmed"),
    });
    return { message: id ? "Saved." : "Added to the Register.", redirectTo: PAGE };
  }, { revalidate: PATHS });
}

export async function deleteStaffRecordAction(id: string, _: Prev) {
  return runAction(async (actor) => {
    await mustBeOpen(actor);
    await deleteStaffRecord(await getDb(), actor, id);
    return { message: "Removed from the Register.", redirectTo: PAGE };
  }, { revalidate: PATHS });
}
