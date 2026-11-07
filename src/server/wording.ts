/**
 * Titles and labels that administrators can change without a code release: role titles and
 * descriptions (Admin > Permissions) and workflow stage and menu wording (Admin > Settings).
 */
import { cache } from "react";
import type { Executor } from "@/db";
import { roles } from "@/db/schema";
import { ROLE_CODES, ROLE_DEFINITIONS, type RoleCode } from "@/lib/auth/permissions";
import { getSettings } from "./settings";

export interface Wording {
  role: Record<RoleCode, { name: string; description: string }>;
  stage: { hr: string; bursary: string; hod: string; lineManager: string; hrDirector: string; approval: string };
  section: { bursary: string; approval: string };
}

async function load(db: Executor): Promise<Wording> {
  const rows = await db.select({ code: roles.code, name: roles.name, description: roles.description }).from(roles);
  // Built-in roles in workflow order, then the roles administrators added.
  const codes = [...ROLE_CODES, ...rows.map((r) => r.code).filter((c) => !(ROLE_CODES as readonly string[]).includes(c))] as RoleCode[];
  const role = Object.fromEntries(codes.map((c) => {
    const r = rows.find((x) => x.code === c);
    return [c, { name: r?.name || ROLE_DEFINITIONS[c]?.name || c, description: r?.description || ROLE_DEFINITIONS[c]?.description || "" }];
  })) as Wording["role"];
  const s = await getSettings(db, ["wording.stageHr", "wording.stageBursary", "wording.stageHod", "wording.stageLineManager", "wording.stageHrDirector", "wording.stageApproval", "wording.sectionBursary", "wording.sectionApproval"]);
  return {
    role,
    stage: { hr: s["wording.stageHr"], bursary: s["wording.stageBursary"], hod: s["wording.stageHod"], lineManager: s["wording.stageLineManager"], hrDirector: s["wording.stageHrDirector"], approval: s["wording.stageApproval"] },
    section: { bursary: s["wording.sectionBursary"], approval: s["wording.sectionApproval"] },
  };
}

/** Per-request cache: pages, menus and documents read the same wording once. */
export const getWording = cache(load);

/** Uncached, for services running inside a transaction. */
export const loadWording = load;

export type ApproverTitle = "hod" | "line_manager";

/** Line Manager, as the administrator set for the department. */
export const APPROVER_TITLES: Record<ApproverTitle, string> = { hod: "HOD", line_manager: "Line Manager" };

/**
 * Name of an approval level: 1 the department's Line Manager (whichever the administrator set),
 * 2 HR Director, 3 Bursar.
 */
export function approvalStageName(w: Wording, level: number, title?: ApproverTitle | null): string {
  if (level <= 1) return title === "line_manager" ? w.stage.lineManager : w.stage.hod;
  return level === 2 ? w.stage.hrDirector : w.stage.approval;
}

/** Display names for a user's roles, in role order, leaving out the automatic ones. */
export function roleTitles(w: Wording, codes: readonly string[]): string[] {
  return (Object.keys(w.role) as RoleCode[]).filter((c) => codes.includes(c) && c !== "APPLICANT" && c !== "GUARANTOR").map((c) => w.role[c].name);
}
