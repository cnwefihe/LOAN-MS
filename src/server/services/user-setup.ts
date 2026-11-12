import { eq, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { departments, staffProfiles, users } from "@/db/schema";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";
import { isInstitutionalEmail } from "./identity";

/**
 * Staff added by an administrator before they first sign in, with their department and, for approvers,
 * the department they approve for as HOD or Line Manager. At first Microsoft sign-in the account is linked
 * by email and keeps everything set here.
 */

export type ApproverRole = "hod" | "line_manager";
export interface NewUser { name: string; email: string; departmentId?: string | null; approver?: ApproverRole | null }

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
type Dept = typeof departments.$inferSelect;

async function setUp(tx: Executor, actor: Actor, input: NewUser, dept: Dept | null) {
  const email = input.email.trim().toLowerCase();
  const name = clean(input.name);
  if (name.length < 3) throw new DomainError("Enter the full name.");
  if (!isInstitutionalEmail(email)) throw new DomainError(`${input.email} is not a university email address.`);
  if (input.approver && !dept) throw new DomainError("Choose the department they approve for.");
  let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  const created = !user;
  if (!user) {
    [user] = await tx.insert(users).values({ email, displayName: name }).returning();
  } else if (!user.entraOid && !user.nameLocked && user.displayName !== name) {
    // Not signed in yet, so the name given here is the best one there is.
    await tx.update(users).set({ displayName: name, updatedAt: new Date() }).where(eq(users.id, user.id));
  }
  await tx.insert(staffProfiles).values({ userId: user.id, departmentId: dept?.id ?? null, schoolId: dept?.schoolId ?? null })
    .onConflictDoUpdate({ target: staffProfiles.userId, set: dept ? { departmentId: dept.id, schoolId: dept.schoolId, updatedAt: new Date() } : { updatedAt: new Date() } });
  if (input.approver && dept) {
    assertCan(actor, "admin.org.manage");
    await tx.update(departments).set({ headUserId: user.id, approverTitle: input.approver }).where(eq(departments.id, dept.id));
    await audit(tx, actor, { action: "org.department_updated", entityType: "department", entityId: dept.id, summary: `Approver for ${dept.name} set`, before: { headUserId: dept.headUserId, approverTitle: dept.approverTitle }, after: { headUserId: user.id, approverTitle: input.approver } });
  }
  await audit(tx, actor, {
    action: created ? "user.added" : "user.updated", entityType: "user", entityId: user.id,
    summary: `${created ? "Added" : "Updated"} ${email}${dept ? `, ${dept.name}` : ""}${input.approver ? `, ${input.approver === "hod" ? "HOD" : "Line Manager"}` : ""}`,
  });
  return { created, userId: user.id };
}

/** Adds one member of staff, or updates them if the email is already known. */
export async function addUser(db: Executor, actor: Actor, input: NewUser) {
  assertCan(actor, "admin.users.manage");
  return db.transaction(async (tx) => {
    let dept: Dept | null = null;
    if (input.departmentId) {
      [dept] = await tx.select().from(departments).where(eq(departments.id, input.departmentId));
      if (!dept) throw new DomainError("Choose a department.");
    }
    return setUp(tx, actor, input, dept);
  });
}

/** Sets the department a member of staff belongs to. Their applications go to that department's approver. */
export async function setUserDepartment(db: Executor, actor: Actor, userId: string, departmentId: string | null) {
  assertCan(actor, "admin.users.manage");
  return db.transaction(async (tx) => {
    const [dept] = departmentId ? await tx.select().from(departments).where(eq(departments.id, departmentId)) : [];
    if (departmentId && !dept) throw new DomainError("Choose a department.");
    await tx.insert(staffProfiles).values({ userId, departmentId: dept?.id ?? null, schoolId: dept?.schoolId ?? null })
      .onConflictDoUpdate({ target: staffProfiles.userId, set: { departmentId: dept?.id ?? null, schoolId: dept?.schoolId ?? null, updatedAt: new Date() } });
    await audit(tx, actor, { action: "user.updated", entityType: "user", entityId: userId, summary: dept ? `Department set to ${dept.name}` : "Department cleared" });
  });
}

/** "HOD", "Head of Department", "Line Manager" and the like; anything else is not a role. */
function readRole(s: string): ApproverRole | null | undefined {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t || t === "none" || t === "staff") return null;
  if (t === "hod" || t === "head" || t === "headofdepartment" || t === "headofdept") return "hod";
  if (t === "linemanager" || t === "lm" || t === "manager") return "line_manager";
  return undefined;
}

/**
 * Adds many people at once, one per line: full name, email, department, and HOD or Line Manager for an
 * approver. Fields are separated by commas, tabs or semicolons, so rows pasted from a spreadsheet work.
 * The department is matched by name or code. Someone already known is updated.
 */
export async function importUsers(db: Executor, actor: Actor, text: string) {
  assertCan(actor, "admin.users.manage");
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new DomainError("Paste at least one line: full name, then email.");
  if (lines.length > 1000) throw new DomainError("Add at most 1,000 people at a time.");
  let added = 0, updated = 0, approvers = 0;
  const skipped: string[] = [];
  await db.transaction(async (tx) => {
    const depts = await tx.select().from(departments);
    const find = (s: string) => {
      const k = clean(s).toLowerCase();
      return depts.find((d) => d.name.toLowerCase() === k || d.code.toLowerCase() === k) ?? null;
    };
    for (const line of lines) {
      if (/^(full\s+)?name\b/i.test(line) && /e-?mail/i.test(line)) continue; // a header row
      const sep = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
      const parts = line.split(sep).map(clean);
      const at = parts.findIndex((p) => /^[^\s@]+@[^\s@]+$/.test(p));
      if (at < 1) { skipped.push(line); continue; }
      let rest = parts.slice(at + 1).filter(Boolean);
      let approver: ApproverRole | null = null;
      if (rest.length) {
        const r = readRole(rest.at(-1)!);
        if (r !== undefined && (rest.length > 1 || r !== null || !find(rest[0]))) { approver = r; rest = rest.slice(0, -1); }
      }
      const deptText = rest.join(", ");
      const dept = deptText ? find(deptText) : null;
      if ((deptText && !dept) || (approver && !dept)) { skipped.push(line); continue; }
      try {
        const r = await setUp(tx, actor, { name: parts.slice(0, at).join(" "), email: parts[at], approver }, dept);
        if (r.created) added++; else updated++;
        if (approver) { approvers++; dept!.headUserId = r.userId; }
      } catch (e) {
        if (e instanceof DomainError) { skipped.push(line); continue; }
        throw e;
      }
    }
    await audit(tx, actor, { action: "user.imported", entityType: "user", summary: `${added} added, ${updated} updated, ${approvers} approvers set, ${skipped.length} not read` });
  });
  return { added, updated, approvers, skipped };
}
