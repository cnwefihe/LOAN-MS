import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { termsDocuments } from "@/db/schema";
import { getSetting } from "@/server/settings";
import { getBranding, logoUrl } from "@/server/branding";
import { DEFAULT_PRIVACY_BODY, DEFAULT_PRIVACY_TITLE, fillPrivacy } from "@/lib/privacy-default";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy notice" };

/** Plain text to HTML: "## " lines are headings, "- " lines are list items, blank lines separate paragraphs. */
function Body({ text }: { text: string }) {
  return text.replace(/\r/g, "").split(/\n{2,}/).map((block, i) => {
    const lines = block.split("\n").filter(Boolean);
    const heading = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : null;
    const items = lines.length && lines.every((l) => l.startsWith("- ")) ? lines.map((l) => l.slice(2)) : null;
    return (
      <section key={i}>
        {heading && <h2>{heading}</h2>}
        {items ? <ul className="list-disc space-y-1 pl-5">{items.map((x) => <li key={x}>{x}</li>)}</ul> : lines.length > 0 && <p>{lines.join(" ")}</p>}
      </section>
    );
  });
}

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
        <h1 className="text-2xl font-semibold text-ink">{fill(published?.title ?? `${brand.systemName}: ${DEFAULT_PRIVACY_TITLE.toLowerCase()}`)}</h1>
        <Body text={fill(published?.body ?? DEFAULT_PRIVACY_BODY)} />
      </article>
    </main>
  );
}
