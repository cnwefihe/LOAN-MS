/**
 * DEVELOPMENT ONLY: opens the suggested sample products (Personal, Bereavement, Asset, and the Salary and Leave Allowance Advance) to
 * staff so they can be seen and tried. The fixture administrator submits and approves each one.
 * In production these stay as drafts for review.
 *   npx tsx scripts/open-sample-products.ts
 */
import "./env";

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
  console.error("Sample products are opened only on the embedded development database.");
  process.exit(1);
}

async function main() {
  const { getDb } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const s = await import("../src/db/schema");
  const { loadActor } = await import("../src/server/services/identity");
  const { submitPolicy, approvePolicy, setProductActive, listPolicyVersions } = await import("../src/server/services/policies");
  const { SUGGESTED_PRODUCTS } = await import("../src/lib/finance/suggested-products");
  const db = await getDb();
  const by = async (email: string) => {
    const [u] = await db.select().from(s.users).where(eq(s.users.email, email));
    return (await loadActor(db, u.id, { ip: "127.0.0.1", userAgent: "open-sample-products" }))!;
  };
  const admin = await by("emeka.nwosu.dev@example.edu.ng");
  for (const sp of SUGGESTED_PRODUCTS) {
    const [product] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, sp.code));
    if (!product) continue;
    const [latest] = await listPolicyVersions(db, product.id);
    if (latest.status === "draft") await submitPolicy(db, admin, latest.id);
    if (latest.status === "draft" || latest.status === "pending_approval") await approvePolicy(db, admin, latest.id);
    if (!product.isActive) await setProductActive(db, admin, product.id, true);
    console.log(`Opened: ${product.name}`);
  }
  const [test] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, "STAFF-PL"));
  if (test?.isActive) { await setProductActive(db, admin, test.id, false); console.log(`Closed: ${test.name}`); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
