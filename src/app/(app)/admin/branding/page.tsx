import { getDb } from "@/db";
import { brandAssets } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { SETTINGS, getSettings, type SettingKey } from "@/server/settings";
import { getBranding, logoUrl, LOGO_VARIANTS, type LogoVariant } from "@/server/branding";
import { Eye } from "lucide-react";
import { Badge, Card, PageHeader, Tabs } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { SettingsGroupForm } from "@/components/settings-form";
import { uploadLogoAction, resetLogoAction } from "@/app/actions/admin";

export const metadata = { title: "Branding and documents" };

const TABS = [{ key: "organisation", label: "Organisation" }, { key: "logos", label: "Logos" }, { key: "documents", label: "Documents" }];

export default async function BrandingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireActor("admin.settings.manage");
  const { tab: chosen } = await searchParams;
  const tab = TABS.some((x) => x.key === chosen) ? chosen! : "organisation";
  const db = await getDb();
  const values = await getSettings(db, Object.keys(SETTINGS) as SettingKey[]);
  const brand = await getBranding(db);
  const uploaded = new Map((await db.select({ variant: brandAssets.variant, updatedAt: brandAssets.updatedAt }).from(brandAssets)).map((r) => [r.variant, r.updatedAt]));

  return (
    <>
      <PageHeader title="Branding and documents" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Branding and documents" }]}
        description="Names, logos, colours and document markings."
        actions={<a href="/api/admin/branding-sample" className="btn-primary h-8 px-3 text-xs"><Eye aria-hidden className="h-3.5 w-3.5" />Preview sample PDF</a>} />

      <Tabs base="/admin/branding" active={tab} tabs={TABS} />
      <div className="space-y-6">
        {tab === "organisation" && <Card title="Organisation" description="Shown on screens, emails and documents.">
          <SettingsGroupForm group="Organisation and branding" values={values} />
        </Card>}

        {tab === "logos" && <Card title="Logos" description="PNG with a transparent background, or JPEG. Maximum 2 MB.">
          <ul className="grid gap-4 sm:grid-cols-2">
            {(Object.keys(LOGO_VARIANTS) as LogoVariant[]).map((v) => {
              const dark = v.endsWith("white");
              return (
                <li key={v} className="rounded-lg border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{LOGO_VARIANTS[v].label}</h3>
                    {uploaded.has(v) ? <Badge tone="brand">Uploaded</Badge> : <Badge>Bundled</Badge>}
                  </div>
                  <div className={`mt-3 grid h-28 place-items-center rounded-md ${dark ? "bg-navy" : "border border-line bg-white"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logoUrl(brand, v)} alt={`Current ${LOGO_VARIANTS[v].label.toLowerCase()}`} className="max-h-20 max-w-[85%] object-contain" />
                  </div>
                  <ActionForm action={uploadLogoAction.bind(null, v)} encType="multipart/form-data" submitLabel="Upload" variant="secondary" resetOnSuccess confirm="Replace this image with the file you chose?">
                    <label htmlFor={`logo-${v}`} className="label mt-3">Replace with</label>
                    <input id={`logo-${v}`} name="logo" type="file" accept="image/png,image/jpeg" required className="input py-1.5" />
                  </ActionForm>
                  {uploaded.has(v) && (
                    <ActionForm action={resetLogoAction.bind(null, v)} submitLabel="Restore bundled logo" variant="secondary" confirm="Restore the bundled logo?" className="mt-2" />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>}

        {tab === "documents" && <Card title="Documents" description="The marking and footer appear on every PDF. {institution} in the footer is replaced by the institution name.">
          <SettingsGroupForm group="Documents" values={values} />
        </Card>}
      </div>
    </>
  );
}
