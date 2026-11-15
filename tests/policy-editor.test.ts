/** The loan terms page checks stored terms as valid: fixed settings stay as words, typed figures become numbers. */
import { describe, expect, it } from "vitest";
import { toPolicy } from "@/components/policy-editor";
import { policyParametersSchema } from "@/lib/finance/policy";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { SUGGESTED_PRODUCTS } from "@/lib/finance/suggested-products";

/** As the page holds them: numbers as typed text, document codes as one line. */
const asForm = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).map(([k, x]) => [k, typeof x === "number" ? String(x) : k === "requiredDocumentCodes" ? (x as string[]).join(", ") : x]));

describe("loan terms page check", () => {
  it("finds nothing to fix in the default terms or any suggested product", () => {
    for (const p of [DEFAULT_POLICY, ...SUGGESTED_PRODUCTS.map((s) => s.policy)]) {
      const r = policyParametersSchema.safeParse(toPolicy(asForm(p as unknown as Record<string, unknown>)));
      expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
    }
  });
});
