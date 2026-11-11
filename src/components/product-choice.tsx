"use client";

import { useEffect, useState } from "react";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { Field } from "./ui";
import { monthsText } from "@/lib/finance/dates";

export interface ProductOption { id: string; label: string; isAdvance: boolean; tenors: number[]; guarantors: number }

const EVENT = "lms:product-kind";

/**
 * Product choice on the application form. A loan asks for a tenor (twelve months at most);
 * an advance asks which payment it is against.
 */
export function ProductChoice({ products, productId, advanceType, tenor }: {
  products: ProductOption[]; productId?: string; advanceType?: string | null; tenor?: number;
}) {
  const [id, setId] = useState(products.find((p) => p.id === productId)?.id ?? products[0]?.id);
  const product = products.find((p) => p.id === id);
  const isAdvance = product?.isAdvance ?? false;
  const [type, setType] = useState(advanceType ?? "");
  // The guarantor section shows as many choices as the product needs (none for an advance or the Bereavement Loan).
  const needed = isAdvance ? 0 : product?.guarantors ?? 0;
  useEffect(() => { window.dispatchEvent(new CustomEvent(EVENT, { detail: needed })); }, [needed]);
  return (
    <>
      <Field label="Product" htmlFor="productId" className="sm:col-span-2">
        <select id="productId" name="productId" value={id} onChange={(e) => setId(e.target.value)} className="input" required>
          {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      {isAdvance ? (
        <>
          <Field label="Advance against" htmlFor="advanceType">
            <select id="advanceType" name="advanceType" value={type} onChange={(e) => setType(e.target.value)} className="input" required>
              <option value="" disabled>Select</option>
              {Object.entries(ADVANCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <input type="hidden" name="tenorMonths" value="1" />
          <p className="text-xs text-muted sm:col-span-2">No interest and no guarantors. It is recovered from the payment it is against.</p>
        </>
      ) : (
        <Field label="Tenor" htmlFor="tenorMonths">
          <select key={id} id="tenorMonths" name="tenorMonths" defaultValue={String(tenor && product?.tenors.includes(tenor) ? tenor : product?.tenors.at(-1) ?? 12)} className="input" required>
            {product?.tenors.map((t) => <option key={t} value={t}>{monthsText(t)}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

/**
 * Guarantors, chosen by name from the list kept by the administrator. Hidden when the product needs none.
 * The same person cannot be chosen twice.
 */
export function GuarantorChoice({ initialCount, options, initial, children }: {
  initialCount: number; options: { id: string; name: string }[]; initial: string[]; children?: React.ReactNode;
}) {
  const [count, setCount] = useState(initialCount);
  const [picked, setPicked] = useState<string[]>([initial[0] ?? "", initial[1] ?? ""]);
  useEffect(() => {
    const on = (e: Event) => setCount((e as CustomEvent<number>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (count === 0) return null;
  return (
    <section aria-labelledby="s3">
      {children}
      {options.length === 0 ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-warning-50 px-3 py-2 text-sm text-warning-ink">The list of guarantors has not been set up yet. Please contact the Bursary.</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {Array.from({ length: Math.min(count, 2) }, (_, i) => (
            <Field key={i} label={`Guarantor ${i + 1}`} htmlFor={`guarantor${i + 1}`}>
              <select id={`guarantor${i + 1}`} name={`guarantor${i + 1}`} value={picked[i]} required className="input"
                onChange={(e) => setPicked((p) => p.map((x, j) => (j === i ? e.target.value : x)))}>
                <option value="" disabled>Choose a name</option>
                {options.map((o) => <option key={o.id} value={o.id} disabled={picked.some((x, j) => j !== i && x === o.id)}>{o.name}</option>)}
              </select>
            </Field>
          ))}
        </div>
      )}
    </section>
  );
}
