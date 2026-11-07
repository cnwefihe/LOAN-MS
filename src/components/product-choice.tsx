"use client";

import { useEffect, useState } from "react";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { Field } from "./ui";
import { monthsText } from "@/lib/finance/dates";

export interface ProductOption { id: string; label: string; isAdvance: boolean; tenors: number[] }

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
  useEffect(() => { window.dispatchEvent(new CustomEvent(EVENT, { detail: isAdvance })); }, [isAdvance]);
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

/** The guarantor nomination section, shown for loans and hidden for advances. */
export function LoanOnly({ initiallyAdvance, children }: { initiallyAdvance: boolean; children: React.ReactNode }) {
  const [advance, setAdvance] = useState(initiallyAdvance);
  useEffect(() => {
    const on = (e: Event) => setAdvance((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return advance ? null : <>{children}</>;
}
