import Link from "next/link";
import { Plus } from "lucide-react";
import { desc, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, loanProducts, policyVersions } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { parsePolicy } from "@/lib/finance/policy";
import { Card, EmptyState, PageHeader, Badge, Stat, StatGrid, Table, Th, Td, DateText } from "@/components/ui";
import { RowMenu } from "@/components/row-menu";
import { paginate, Pagination } from "@/components/pagination";

export const metadata = { title: "Products & policies" };

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

export default async function Products({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const sp = await searchParams;
  const actor = await requireActor("admin.policy.manage", "admin.policy.approve");
  const db = await getDb();
  const products = await db.select().from(loanProducts).orderBy(loanProducts.name);
  const versions = await db.select().from(policyVersions).orderBy(desc(policyVersions.version));
  const open = products.filter((p) => p.isActive).length;
  // Applications moving through the workflow, across all products.
  const [inProgress] = await db.select({ n: sql<number>`count(*)` }).from(loanApplications)
    .where(inArray(loanApplications.status, ["pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "returned"]));
  return (
    <>
      <PageHeader title="Loan products & policies" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Products" }]}
        description="Loan products and their terms. Open a product to change its terms and save."
        actions={can(actor, "admin.policy.manage") ? <Link href="/admin/products/new" className="btn-primary h-8 px-3 text-xs"><Plus aria-hidden className="h-3.5 w-3.5" />New product</Link> : undefined} />
      <StatGrid>
        <Stat label="Products" value={products.length} />
        <Stat label="Open" value={open} tone="success" />
        <Stat label="Closed" value={products.length - open} />
        <Stat label="Applications in progress" value={Number(inProgress.n)} hint="Across all products" tone="brand" />
      </StatGrid>
      <Card bodyClassName="p-5 py-0">
        {products.length === 0 ? <div className="py-5"><EmptyState title="No products yet" /></div> : (
          <Table caption="Loan products">
            <thead><tr><Th>Product</Th><Th>Code</Th><Th>Status</Th><Th>Interest</Th><Th>Tenor</Th><Th>Last updated</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {paginate(products, sp.page, sp.size).items.map((p) => {
                const pv = versions.filter((v) => v.productId === p.id);
                const active = pv.find((v) => v.status === "active");
                const terms = active ? parsePolicy(active.parameters) : null;
                return (
                  <tr key={p.id}>
                    <Td className="font-medium">{p.name}</Td>
                    <Td className="font-mono text-xs text-muted">{p.code}</Td>
                    <Td>{p.isActive ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}</Td>
                    <Td>{!terms ? "-" : terms.interestMethod === "interest_free" ? "Interest free" : `${terms.annualInterestRate}% a year`}</Td>
                    <Td>{!terms ? "-" : terms.minTenorMonths === terms.maxTenorMonths ? months(terms.maxTenorMonths) : `${terms.minTenorMonths} to ${months(terms.maxTenorMonths)}`}</Td>
                    <Td>{active ? <DateText value={active.effectiveFrom ?? active.approvedAt ?? active.createdAt} /> : <Badge tone="warning">Terms not saved</Badge>}</Td>
                    <Td right><RowMenu label={p.name} items={[{ label: "Manage", href: `/admin/products/${p.id}` }]} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination data={paginate(products, sp.page, sp.size)} base="/admin/products" label="products" />
      </Card>
    </>
  );
}
