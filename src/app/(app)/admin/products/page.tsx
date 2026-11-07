import Link from "next/link";
import { Plus } from "lucide-react";
import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { loanProducts, policyVersions } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { parsePolicy } from "@/lib/finance/policy";
import { Card, EmptyState, PageHeader, Badge, Stat, StatGrid, Table, Th, Td } from "@/components/ui";
import { RowMenu } from "@/components/row-menu";

export const metadata = { title: "Products & policies" };

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

export default async function Products() {
  const actor = await requireActor("admin.policy.manage", "admin.policy.approve");
  const db = await getDb();
  const products = await db.select().from(loanProducts).orderBy(loanProducts.name);
  const versions = await db.select().from(policyVersions).orderBy(desc(policyVersions.version));
  const open = products.filter((p) => p.isActive).length;
  const awaiting = versions.filter((v) => v.status === "pending_approval").length;
  return (
    <>
      <PageHeader title="Loan products & policies" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Products" }]}
        description="Loan products and their policy versions."
        actions={can(actor, "admin.policy.manage") ? <Link href="/admin/products/new" className="btn-primary h-8 px-3 text-xs"><Plus aria-hidden className="h-3.5 w-3.5" />New product</Link> : undefined} />
      <StatGrid>
        <Stat label="Products" value={products.length} />
        <Stat label="Open" value={open} tone="success" />
        <Stat label="Closed" value={products.length - open} />
        <Stat label="Policies awaiting approval" value={awaiting} tone={awaiting ? "warning" : "default"} />
      </StatGrid>
      <Card bodyClassName="p-5 py-0">
        {products.length === 0 ? <div className="py-5"><EmptyState title="No products yet" /></div> : (
          <Table caption="Loan products">
            <thead><tr><Th>Product</Th><Th>Code</Th><Th>Status</Th><Th>Active policy</Th><Th>Interest</Th><Th>Tenor</Th><Th>Changes</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {products.map((p) => {
                const pv = versions.filter((v) => v.productId === p.id);
                const active = pv.find((v) => v.status === "active");
                const terms = active ? parsePolicy(active.parameters) : null;
                const pending = pv.filter((v) => v.status === "pending_approval" || v.status === "draft");
                return (
                  <tr key={p.id}>
                    <Td className="font-medium">{p.name}</Td>
                    <Td className="font-mono text-xs text-muted">{p.code}</Td>
                    <Td>{p.isActive ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}</Td>
                    <Td>{active ? `Version ${active.version}` : <Badge tone="warning">None</Badge>}</Td>
                    <Td>{!terms ? "-" : terms.interestMethod === "interest_free" ? "Interest free" : `${terms.annualInterestRate}% a year`}</Td>
                    <Td>{!terms ? "-" : terms.minTenorMonths === terms.maxTenorMonths ? months(terms.maxTenorMonths) : `${terms.minTenorMonths} to ${months(terms.maxTenorMonths)}`}</Td>
                    <Td>{pending.length ? <div className="flex gap-1">{pending.map((v) => <Badge key={v.id} tone={v.status === "draft" ? "neutral" : "warning"}>Version {v.version} {v.status === "draft" ? "draft" : "awaiting approval"}</Badge>)}</div> : "-"}</Td>
                    <Td right><RowMenu label={p.name} items={[{ label: "View policy", href: `/admin/products/${p.id}` }, { label: "Version history", href: `/admin/products/${p.id}?tab=versions` }, { label: "Product settings", href: `/admin/products/${p.id}?tab=settings` }]} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
