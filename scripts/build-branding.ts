/**
 * npm run branding
 *
 * Builds the web and PDF brand assets from the source artwork in ./branding:
 *   - a file whose name contains "Standard" or "Blue"     → full-colour logo (light backgrounds)
 *   - a file whose name contains "Reversed" or "White"    → reversed logo (dark backgrounds)
 *   - optionally a file whose name contains "Crest"       → crest; otherwise it is cropped from the logo
 *
 * Outputs (committed, served from /branding/...):
 *   public/branding/logo.png, logo-white.png, crest.png, crest-white.png
 *   src/app/icon.png, src/app/apple-icon.png (browser tab and home-screen icons)
 *
 * Administrators can also replace the logos at runtime from Administration > Branding; uploaded
 * logos take precedence over these files.
 */
import fs from "node:fs";
import path from "node:path";
import sharp, { type Sharp, type Color } from "sharp";

const SRC = path.join(process.cwd(), "branding");
const OUT = path.join(process.cwd(), "public", "branding");

function find(...words: string[]): string | null {
  if (!fs.existsSync(SRC)) return null;
  const f = fs.readdirSync(SRC).find((n) => /\.(png|jpe?g|webp)$/i.test(n) && words.some((w) => n.toLowerCase().includes(w)));
  return f ? path.join(SRC, f) : null;
}

/** Finds the crest as the left-most block of opaque columns, separated from the wordmark by a transparent gap. */
async function cropCrest(file: string): Promise<Sharp> {
  const trimmed = await sharp(file).trim().png().toBuffer();
  const { data, info } = await sharp(trimmed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque = (x: number) => {
    for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3] > 24) return true;
    return false;
  };
  let x = 0;
  while (x < info.width && opaque(x)) x++;
  const width = Math.max(1, Math.min(x, info.width));
  return sharp(trimmed).extract({ left: 0, top: 0, width, height: info.height }).trim();
}

async function main() {
  const standard = find("standard", "blue");
  const reversed = find("reversed", "white");
  const crestSrc = find("crest");
  if (!standard) throw new Error("No standard logo found in ./branding (file name should contain 'Standard' or 'Blue').");
  fs.mkdirSync(OUT, { recursive: true });

  await sharp(standard).trim().resize({ width: 900, withoutEnlargement: true }).png({ compressionLevel: 9 }).toFile(path.join(OUT, "logo.png"));
  if (reversed) await sharp(reversed).trim().resize({ width: 900, withoutEnlargement: true }).png({ compressionLevel: 9 }).toFile(path.join(OUT, "logo-white.png"));

  const crest = crestSrc ? sharp(crestSrc).trim() : await cropCrest(standard);
  const crestPng = await crest.resize({ height: 256, withoutEnlargement: true }).png().toBuffer();
  fs.writeFileSync(path.join(OUT, "crest.png"), crestPng);
  if (reversed && !crestSrc) {
    const whiteCrest = await (await cropCrest(reversed)).resize({ height: 256 }).png().toBuffer();
    fs.writeFileSync(path.join(OUT, "crest-white.png"), whiteCrest);
  }

  const square = async (size: number, background: Color) =>
    sharp({ create: { width: size, height: size, channels: 4, background } })
      .composite([{ input: await sharp(crestPng).resize({ width: Math.round(size * 0.8), height: Math.round(size * 0.8), fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(), gravity: "centre" }])
      .png();
  await (await square(64, { r: 0, g: 0, b: 0, alpha: 0 })).toFile(path.join(process.cwd(), "src", "app", "icon.png"));
  await (await square(180, { r: 255, g: 255, b: 255, alpha: 1 })).toFile(path.join(process.cwd(), "src", "app", "apple-icon.png"));

  for (const f of fs.readdirSync(OUT)) {
    const m = await sharp(path.join(OUT, f)).metadata();
    console.log(`public/branding/${f}  ${m.width}x${m.height}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
