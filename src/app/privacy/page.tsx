import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { termsDocuments } from "@/db/schema";
import { getSetting } from "@/server/settings";
import { getBranding, logoUrl } from "@/server/branding";
import { RichText } from "@/components/rich-text";
import { DEFAULT_PRIVACY_BODY, DEFAULT_PRIVACY_TITLE, fillPrivacy } from "@/lib/privacy-default";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy notice" };

export default async function Privacy() {
  const db = await getDb();
  const dpo = await getSetting(db, "privacy.dpoEmail");
  const brand = await getBranding(db);
  const [published] = await db.select().from(termsDocuments).where(and(eq(termsDocuments.kind, "privacy_notice"), eq(termsDocuments.isActive, true)));
  const fill = (s: string) => fillPrivacy(s, { institution: brand.institutionName, system: brand.systemName, dpo });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl(brand, "logo")} alt={brand.institutionName} className="h-12 w-auto" />
        <Link href="/dashboard" className="link text-sm">Back to the {brand.systemName}</Link>
      </div>
      {!published && (
        <div className="mb-6 rounded-md border border-amber-200 bg-warning-50 px-4 py-3 text-sm text-warning-ink" role="note">
          Draft notice. It must be reviewed and approved by the institution&apos;s Data Protection Officer and Legal Office before go-live.
        </div>
      )}
      <article className="space-y-5 text-sm leading-relaxed text-slate-800 [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-navy">
        <h1 className="text-2xl font-semibold text-ink">{fill(published?.title ?? DEFAULT_PRIVACY_TITLE)}</h1>
        <RichText text={fill(published?.body ?? DEFAULT_PRIVACY_BODY)} />
      </article>
    </main>
  );
}
