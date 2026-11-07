/**
 * DEVELOPMENT ONLY: copies the suggested products' current descriptions onto the matching products in the
 * embedded development database (seeding never changes a product that already exists).
 *   npx tsx scripts/sync-product-descriptions.ts
 */
import "./env";

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
  console.error("Descriptions are synchronised only on the embedded development database.");
  process.exit(1);
}

async function main() {
  const { getDb } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const s = await import("../src/db/schema");
  const { SUGGESTED_PRODUCTS } = await import("../src/lib/finance/suggested-products");
  const db = await getDb();
  for (const sp of SUGGESTED_PRODUCTS) {
    const updated = await db.update(s.loanProducts).set({ description: sp.description }).where(eq(s.loanProducts.code, sp.code)).returning({ name: s.loanProducts.name });
    if (updated.length) console.log(`Updated: ${updated[0].name}`);
    for (const d of sp.documents) await db.update(s.documentRequirements).set({ label: d.label }).where(eq(s.documentRequirements.code, d.code));
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
