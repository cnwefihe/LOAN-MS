import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { notifications, notificationTemplates, emailOutbox, users, userRoles, roles } from "@/db/schema";
import type { RoleCode } from "@/lib/auth/permissions";
import { getSetting } from "./settings";
import { DEFAULT_TEMPLATES } from "./notification-templates";

export type Vars = Record<string, string | number | null | undefined>;

export function render(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

interface NotifyInput {
  template: string;
  userIds?: string[];
  roles?: RoleCode[];
  vars: Vars;
  link?: string;
  /** Prevents duplicate emails for the same event (e.g. one reminder per instalment). */
  dedupeKey?: string;
  excludeUserIds?: string[];
}

/**
 * Record in-app notifications and queue institutional emails in the same transaction as the
 * business event. Emails are delivered asynchronously by the outbox dispatcher (server/email.ts).
 */
export async function notify(db: Executor, input: NotifyInput): Promise<void> {
  const ids = new Set(input.userIds ?? []);
  if (input.roles?.length) {
    const rows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(inArray(roles.code, input.roles), eq(users.isActive, true)));
    rows.forEach((r) => ids.add(r.userId));
  }
  input.excludeUserIds?.forEach((id) => ids.delete(id));
  if (!ids.size) return;

  const [tpl] = await db.select().from(notificationTemplates).where(eq(notificationTemplates.code, input.template));
  const fallback = DEFAULT_TEMPLATES.find((t) => t.code === input.template);
  if (tpl && !tpl.isActive) return;
  const subject = tpl?.subject ?? fallback?.subject ?? input.template;
  const body = tpl?.body ?? fallback?.body ?? "";
  const sendEmail = (tpl?.sendEmail ?? true) && (await getSetting(db, "notifications.emailEnabled"));

  const recipients = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, [...ids]));
  for (const r of recipients) {
    // Emails greet people by first name ("Dear Adaeze,"); recipientName stays available to templates.
    const vars = { ...input.vars, recipientName: r.displayName, firstName: r.displayName.trim().split(/\s+/)[0] };
    const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${r.id}` : null;
    const [n] = await db.insert(notifications).values({
      userId: r.id, templateCode: input.template, title: render(subject, vars), body: render(body, vars), link: input.link ?? null, dedupeKey,
    }).onConflictDoNothing().returning({ id: notifications.id });
    if (!n) continue; // already notified for this event
    if (sendEmail) {
      const base = process.env.APP_BASE_URL?.replace(/\/$/, "");
      const linkLine = input.link && base ? `\n\nOpen: ${base}${input.link}` : "";
      await db.insert(emailOutbox).values({
        notificationId: n.id, toAddress: r.email, subject: render(subject, vars),
        // Branding, sign-off and the confidentiality footer are added when the email is composed for sending.
        body: `${render(body, vars)}${linkLine}`,
        dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${r.id}` : null,
      }).onConflictDoNothing();
    }
  }
}
