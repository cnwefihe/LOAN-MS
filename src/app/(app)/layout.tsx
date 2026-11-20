import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { staffProfiles, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { buildNav } from "@/lib/nav";
import { getWording, roleTitles } from "@/server/wording";
import { getBranding, logoUrl } from "@/server/branding";
import { getSettings, idleMinutesFor } from "@/server/settings";
import { AppShell } from "@/components/shell";
import { IdleGuard } from "@/components/idle-guard";
import { ListMemoryRecorder } from "@/components/list-memory";
import { Suspense } from "react";
import { currentVersion } from "@/server/services/releases";
import { myGuides, supportAvailable, SUPPORT_CATEGORIES } from "@/server/services/assistant";
import { Assistant } from "@/components/assistant";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const db = await getDb();
  const { sections, unread } = await buildNav(db, actor);
  const [u] = await db.select({ dev: users.isDevFixture }).from(users).where(eq(users.id, actor.userId));
  // The name saved under My details comes first: Microsoft resets the account name at each sign-in.
  const [profile] = await db.select({ name: staffProfiles.payslipName }).from(staffProfiles).where(eq(staffProfiles.userId, actor.userId));
  const brand = await getBranding(db);
  const notice = await getSettings(db, ["system.announcement", "system.announcementTone"]);
  const roleNames = roleTitles(await getWording(db), actor.roles);
  // The assistant: guides this person may read, their own next steps and the work waiting for them.
  const work = sections.filter((s) => s.title !== "Self-service").flatMap((s) => s.items.filter((i) => (i.badge ?? 0) > 0 && i.href !== "/guarantor").map((i) => ({ label: `${s.title} > ${i.label}`, href: i.href, count: i.badge ?? 0 })));
  const userName = profile?.name?.trim() || actor.displayName;
  return (
    <AppShell
      sections={sections} unread={unread} devBanner={!!u?.dev}
      brand={{ systemName: brand.systemName, institutionName: brand.institutionName, logoWhite: logoUrl(brand, "logo-white"), crestWhite: logoUrl(brand, "crest-white"), version: await currentVersion(db) }}
      announcement={notice["system.announcement"] ? { text: notice["system.announcement"], tone: notice["system.announcementTone"] } : null}
      user={{ name: profile?.name?.trim() || actor.displayName, email: actor.email, roles: roleNames.length ? roleNames : ["Staff"] }}>
      <Suspense fallback={null}><ListMemoryRecorder /></Suspense>
      <IdleGuard minutes={await idleMinutesFor(db, actor.roles)} />
      {children}
      <Assistant guideIds={(await myGuides(db, actor)).map((g) => g.id)} work={work.map((w) => ({ text: `${w.count} waiting in ${w.label}.`, href: w.href, tone: "info" as const }))} support={await supportAvailable(db)} categories={SUPPORT_CATEGORIES} firstName={userName.split(" ")[0]} />
    </AppShell>
  );
}
