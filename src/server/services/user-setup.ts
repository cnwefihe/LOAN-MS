import { eq, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { departments, schools, staffProfiles, users } from "@/db/schema";
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
export interface NewUser {
  name: string; email: string; approver?: ApproverRole | null;
  /** An existing department by id, or one by name: found by name or code, or created (with `schoolName`). */
  departmentId?: string | null; departmentName?: string | null; schoolName?: string | null;
  /** The employee code, when known; otherwise it comes from Microsoft at first sign-in. */
  staffNumber?: string | null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
type Dept = typeof departments.$inferSelect;
type School = typeof schools.$inferSelect;

/** A short unused code made from a name: "Human Resources" gives "HR", then "HR2" if that is taken. */
function codeFor(name: string, taken: Set<string>): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !["OF", "AND", "THE", "FOR"].includes(w));
  const base = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "DEPT").slice(0, 4)).slice(0, 16) || "DEPT";
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}${i}`;
  taken.add(code);
  return code;
}

/** The school named, found by name or code (any case), or created when there is none. */
export async function findOrCreateSchool(tx: Executor, actor: Actor, schoolName: string): Promise<School & { created?: boolean }> {
  const name = clean(schoolName);
  const key = name.toLowerCase();
  const allSchools = await tx.select().from(schools);
  const found = allSchools.find((s) => s.name.toLowerCase() === key || s.code.toLowerCase() === key);
  if (found) return found;
  assertCan(actor, "admin.org.manage");
  const [school] = await tx.insert(schools).values({ code: codeFor(name, new Set(allSchools.map((s) => s.code))), name }).returning();
  await audit(tx, actor, { action: "org.school_created", entityType: "school", entityId: school.id, summary: `Created ${school.name}`, after: school });
  return { ...school, created: true };
}

/**
 * The department named, found by name or code (any case), or created when there is none, so people can be
 * added before the organisation structure is set up. A new department is put in the school named, which is
 * likewise found or created. An existing department without a school is given the one named.
 */
export async function findOrCreateDepartment(tx: Executor, actor: Actor, departmentName: string, schoolName?: string | null): Promise<Dept> {
  const name = clean(departmentName);
  if (name.length < 2) throw new DomainError("Enter the department's name.");
  const key = name.toLowerCase();
  const school = schoolName?.trim() ? await findOrCreateSchool(tx, actor, schoolName) : null;
  const all = await tx.select().from(departments);
  const found = all.find((d) => d.name.toLowerCase() === key || d.code.toLowerCase() === key);
  if (found) {
    if (school && !found.schoolId) {
      await tx.update(departments).set({ schoolId: school.id }).where(eq(departments.id, found.id));
      return { ...found, schoolId: school.id };
    }
    return found;
  }
  assertCan(actor, "admin.org.manage");
  const [dept] = await tx.insert(departments).values({ code: codeFor(name, new Set(all.map((d) => d.code))), name, schoolId: school?.id ?? null }).returning();
  await audit(tx, actor, { action: "org.department_created", entityType: "department", entityId: dept.id, summary: `Created ${dept.name} while adding staff`, after: dept });
  return dept;
}

async function setUp(tx: Executor, actor: Actor, input: NewUser, dept: Dept | null) {
  const email = input.email.trim().toLowerCase();
  const name = clean(input.name);
  if (name.length < 3) throw new DomainError("Enter the full name.");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || !isInstitutionalEmail(email)) throw new DomainError(`${input.email} is not a work email address.`);
  if (input.approver && !dept) throw new DomainError("Choose the department they approve for.");
  let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  const created = !user;
  if (!user) {
    [user] = await tx.insert(users).values({ email, displayName: name }).returning();
  } else if (!user.entraOid && !user.nameLocked && user.displayName !== name) {
    // Not signed in yet, so the name given here is the best one there is.
    await tx.update(users).set({ displayName: name, updatedAt: new Date() }).where(eq(users.id, user.id));
  }
  const code = input.staffNumber?.trim() || null;
  await tx.insert(staffProfiles).values({ userId: user.id, departmentId: dept?.id ?? null, schoolId: dept?.schoolId ?? null, staffNumber: code })
    .onConflictDoUpdate({ target: staffProfiles.userId, set: { ...(dept ? { departmentId: dept.id, schoolId: dept.schoolId } : {}), ...(code ? { staffNumber: code } : {}), updatedAt: new Date() } });
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
    } else if (input.departmentName?.trim()) {
      dept = await findOrCreateDepartment(tx, actor, input.departmentName, input.schoolName);
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
 * Adds many people at once, one per line: full name, email, department, school, and HOD or Line Manager for
 * an approver (school and role may be left out). Fields are separated by commas, tabs or semicolons, so rows
 * pasted from a spreadsheet work. A department or school not yet set up is created. Someone already known is updated.
 */
export async function importUsers(db: Executor, actor: Actor, text: string) {
  assertCan(actor, "admin.users.manage");
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new DomainError("Paste at least one line: full name, then email.");
  if (lines.length > 1000) throw new DomainError("Add at most 1,000 people at a time.");
  let added = 0, updated = 0, approvers = 0, departmentsAdded = 0;
  const skipped: string[] = [];
  await db.transaction(async (tx) => {
    const before = new Set((await tx.select({ id: departments.id }).from(departments)).map((d) => d.id));
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
        if (r !== undefined) { approver = r; rest = rest.slice(0, -1); }
      }
      const [deptText, ...schoolParts] = rest;
      if (approver && !deptText) { skipped.push(line); continue; }
      try {
        const dept = deptText ? await findOrCreateDepartment(tx, actor, deptText, schoolParts.join(", ") || null) : null;
        if (dept && !before.has(dept.id)) { before.add(dept.id); departmentsAdded++; }
        const r = await setUp(tx, actor, { name: parts.slice(0, at).join(" "), email: parts[at], approver }, dept);
        if (r.created) added++; else updated++;
        if (approver) approvers++;
      } catch (e) {
        if (e instanceof DomainError) { skipped.push(line); continue; }
        throw e;
      }
    }
    await audit(tx, actor, { action: "user.imported", entityType: "user", summary: `${added} added, ${updated} updated, ${approvers} approvers set, ${departmentsAdded} departments created, ${skipped.length} not read` });
  });
  return { added, updated, approvers, departmentsAdded, skipped };
}

/**
 * Adds many departments at once, one per line: department, school, then HOD or Line Manager for who approves
 * (optional; HOD if left out). Fields are separated by commas, tabs or semicolons, so rows pasted from a
 * spreadsheet work. Schools not set up yet are created. A department already known is moved to the school named.
 */
export async function importOrganisation(db: Executor, actor: Actor, text: string) {
  assertCan(actor, "admin.org.manage");
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new DomainError("Paste at least one line: department, then school.");
  if (lines.length > 1000) throw new DomainError("Add at most 1,000 departments at a time.");
  let departmentsAdded = 0, departmentsUpdated = 0, schoolsAdded = 0;
  const skipped: string[] = [];
  await db.transaction(async (tx) => {
    for (const line of lines) {
      if (/^department\b/i.test(line) && /school|faculty/i.test(line)) continue; // a header row
      const sep = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
      const parts = line.split(sep).map(clean).filter(Boolean);
      let title: ApproverRole | undefined;
      if (parts.length > 2) {
        const r = readRole(parts.at(-1)!);
        if (r) { title = r; parts.pop(); }
      }
      const [deptName, ...schoolParts] = parts;
      if (!deptName || deptName.length < 2 || !schoolParts.length) { skipped.push(line); continue; }
      const school = await findOrCreateSchool(tx, actor, schoolParts.join(", "));
      if (school.created) schoolsAdded++;
      const key = deptName.toLowerCase();
      const all = await tx.select().from(departments);
      const found = all.find((d) => d.name.toLowerCase() === key || d.code.toLowerCase() === key);
      if (found) {
        const set = { ...(found.schoolId !== school.id ? { schoolId: school.id } : {}), ...(title && title !== found.approverTitle ? { approverTitle: title } : {}) };
        if (Object.keys(set).length) {
          await tx.update(departments).set(set).where(eq(departments.id, found.id));
          await audit(tx, actor, { action: "org.department_updated", entityType: "department", entityId: found.id, summary: `${found.name} put in ${school.name}`, before: { schoolId: found.schoolId, approverTitle: found.approverTitle }, after: set });
          departmentsUpdated++;
        }
        continue;
      }
      const [dept] = await tx.insert(departments).values({ code: codeFor(deptName, new Set(all.map((d) => d.code))), name: deptName, schoolId: school.id, approverTitle: title ?? "hod" }).returning();
      await audit(tx, actor, { action: "org.department_created", entityType: "department", entityId: dept.id, summary: `Created ${dept.name} in ${school.name}`, after: dept });
      departmentsAdded++;
    }
    await audit(tx, actor, { action: "org.imported", entityType: "department", summary: `${departmentsAdded} departments added, ${departmentsUpdated} updated, ${schoolsAdded} schools added, ${skipped.length} not read` });
  });
  return { departmentsAdded, departmentsUpdated, schoolsAdded, skipped };
}
