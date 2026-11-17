"use server";

import { getDb } from "@/db";
import { runAction, str } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { addUser, importUsers, setUserDepartment, type ApproverRole } from "@/server/services/user-setup";

type Prev = ActionResult | null;
const PATHS = ["/admin/users", "/admin/organisation"];
const role = (s: string): ApproverRole | null => (s === "hod" || s === "line_manager" ? s : null);

export async function addUserAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const r = await addUser(await getDb(), actor, {
      name: str(fd, "name", true), email: str(fd, "email", true), staffNumber: str(fd, "staffNumber") || null, departmentName: str(fd, "departmentName") || null, schoolName: str(fd, "schoolName") || null, approver: role(str(fd, "approver")),
    });
    return r.created ? "User added. They can sign in with their university account." : "This person was already known; their details have been updated.";
  }, { revalidate: PATHS });
}

export async function importUsersAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const r = await importUsers(await getDb(), actor, str(fd, "lines", true));
    const skipped = r.skipped.length ? ` These lines could not be read: ${r.skipped.slice(0, 5).join("; ")}${r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ""}.` : "";
    return `${r.added} added, ${r.updated} updated, ${r.approvers} set as approvers${r.departmentsAdded ? `, ${r.departmentsAdded} new ${r.departmentsAdded === 1 ? "department" : "departments"} created` : ""}.${skipped}`;
  }, { revalidate: PATHS });
}

export async function setUserDepartmentAction(userId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await setUserDepartment(await getDb(), actor, userId, str(fd, "departmentId") || null);
    return "Department saved.";
  }, { revalidate: [...PATHS, `/admin/users/${userId}`] });
}
