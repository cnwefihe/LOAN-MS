import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { brandAssets } from "@/db/schema";
import { getSettings } from "./settings";

export const LOGO_VARIANTS = {
  logo: { label: "Full-colour logo (light backgrounds)", file: "logo.png" },
  "logo-white": { label: "Reversed logo (dark backgrounds)", file: "logo-white.png" },
  crest: { label: "Crest (compact spaces)", file: "crest.png" },
  "crest-white": { label: "Reversed crest (compact spaces on dark backgrounds)", file: "crest-white.png" },
} as const;
export type LogoVariant = keyof typeof LOGO_VARIANTS;
export const isLogoVariant = (v: string): v is LogoVariant => v in LOGO_VARIANTS;

export interface Branding {
  institutionName: string;
  shortName: string;
  systemName: string;
  address: string;
  supportEmail: string;
  supportPhone: string;
  primaryColour: string;
  confidentialMarking: string;
  footerNotice: string;
  watermark: boolean;
  emailSignature: string;
  /** Changes whenever an administrator uploads a logo; used to bust browser caches. */
  logoVersion: string;
}

export async function getBranding(db: Executor): Promise<Branding> {
  const s = await getSettings(db, [
    "org.institutionName", "org.shortName", "org.systemName", "org.address", "org.supportEmail", "org.supportPhone", "branding.primaryColour",
    "documents.confidentialMarking", "documents.footerNotice", "documents.watermarkEnabled", "notifications.emailSignature",
  ]);
  const assets = await db.select({ variant: brandAssets.variant, sha: brandAssets.sha256 }).from(brandAssets);
  return {
    institutionName: s["org.institutionName"], shortName: s["org.shortName"], systemName: s["org.systemName"], address: s["org.address"],
    supportEmail: s["org.supportEmail"], supportPhone: s["org.supportPhone"], primaryColour: s["branding.primaryColour"].toUpperCase(),
    confidentialMarking: s["documents.confidentialMarking"], footerNotice: s["documents.footerNotice"].replaceAll("{institution}", s["org.institutionName"]), watermark: s["documents.watermarkEnabled"],
    emailSignature: s["notifications.emailSignature"],
    logoVersion: assets.map((a) => `${a.variant}:${a.sha.slice(0, 8)}`).sort().join(",").slice(0, 120) || "bundled",
  };
}

const fileCache = new Map<string, Buffer>();

async function bundled(variant: LogoVariant): Promise<Buffer | null> {
  const file = LOGO_VARIANTS[variant].file;
  if (fileCache.has(file)) return fileCache.get(file)!;
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", "branding", file));
    fileCache.set(file, buf);
    return buf;
  } catch {
    return null;
  }
}

/** The logo image to use: an administrator upload when present, otherwise the bundled file. */
export async function getLogo(db: Executor, variant: LogoVariant): Promise<{ bytes: Buffer; mimeType: string; source: "uploaded" | "bundled" } | null> {
  const [row] = await db.select().from(brandAssets).where(eq(brandAssets.variant, variant));
  if (row) return { bytes: Buffer.from(row.dataBase64, "base64"), mimeType: row.mimeType, source: "uploaded" };
  const b = await bundled(variant);
  return b ? { bytes: b, mimeType: "image/png", source: "bundled" } : null;
}

export const logoUrl = (b: Branding, variant: LogoVariant) => `/api/branding/${variant}?v=${encodeURIComponent(b.logoVersion)}`;
