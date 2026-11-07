/** Builds the installable-app icons in public/pwa from the crest. Run after changing the crest: npx tsx scripts/build-pwa-icons.ts */
import fs from "node:fs";
import sharp from "sharp";

const NAVY = "#2E3A6E";

async function icon(size: number, crestShare: number, file: string) {
  const crest = await sharp("public/branding/crest-white.png")
    .resize({ height: Math.round(size * crestShare), fit: "inside" })
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: crest, gravity: "centre" }])
    .png()
    .toFile(`public/pwa/${file}`);
}

async function main() {
  fs.mkdirSync("public/pwa", { recursive: true });
  await icon(192, 0.72, "icon-192.png");
  await icon(512, 0.72, "icon-512.png");
  // Phones crop maskable icons into a circle or rounded shape, so the crest stays inside the safe zone.
  await icon(512, 0.56, "maskable-512.png");
  console.log("Icons written to public/pwa");
}

main();
