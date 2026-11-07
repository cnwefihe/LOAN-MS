/**
 * DEVELOPMENT ONLY: moves the embedded development database onto payslip-based eligibility. The active loan
 * policies get the 33.3%-of-net-pay deduction limit and the ₦25,000 cafeteria amount; each test account gets
 * its pay grade and a sample payslip (made-up figures). In production these changes are made through the
 * administrator's policy approval and by staff uploading their own payslips.
 *   npx tsx scripts/apply-payslip-rule.ts
 */
import "./env";

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
  console.error("This script runs only on the embedded development database.");
  process.exit(1);
}

async function main() {
  const { getDb } = await import("../src/db");
  const { and, eq, isNull } = await import("drizzle-orm");
  const s = await import("../src/db/schema");
  const { FIXTURE_USERS, fixtureGrade, fixturePayslip } = await import("../src/server/seed");
  const { latestPayslip, recordSamplePayslip } = await import("../src/server/services/payslips");
  const db = await getDb();

  for (const v of await db.select().from(s.policyVersions).where(eq(s.policyVersions.status, "active"))) {
    const p = v.parameters as Record<string, unknown>;
    if (p.productType === "advance") continue;
    await db.update(s.policyVersions).set({ parameters: { ...p, affordabilityRule: "deduction_cap", deductionBasis: "net", maxDeductionPercent: 33.3, cafeteriaAmount: "25000.00" } }).where(eq(s.policyVersions.id, v.id));
    console.log(`Policy updated: version ${v.version} of product ${v.productId}`);
  }

  for (const f of FIXTURE_USERS) {
    const [u] = await db.select().from(s.users).where(eq(s.users.email, f.email));
    if (!u) continue;
    await db.update(s.staffProfiles).set({ payGrade: fixtureGrade(f) }).where(and(eq(s.staffProfiles.userId, u.id), isNull(s.staffProfiles.payGrade)));
    if (!(await latestPayslip(db, u.id))) {
      await recordSamplePayslip(db, { userId: u.id, email: f.email, displayName: f.name, roles: [], permissions: new Set() }, u.id, fixturePayslip(f));
      console.log(`Sample payslip added: ${f.name}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
