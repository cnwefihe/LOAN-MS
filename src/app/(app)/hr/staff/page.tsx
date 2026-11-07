import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { staffDirectory } from "@/server/services/hr";
import { Card, PageHeader, Table, Th, Td, Money, Badge } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";

import { paginate, Pagination } from "@/components/pagination";
export const metadata = { title: "Staff records" };

export default async function StaffRecords({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("hr.staff.view");
  const { q, page, size } = await searchParams;
  const rows = await staffDirectory(await getDb(), actor, q);
  const pg = paginate(rows, page, size);
  return (
    <>
      <PageHeader title="Staff records" crumbs={[{ label: "Human Resources", href: "/hr" }, { label: "Staff" }]} description="Employment and salary records." />
      <Card bodyClassName="p-5">
        <SearchFilter q={q} placeholder="Search name, email or staff number" />
        <Table caption="Staff records">
          <thead><tr><Th>Name</Th><Th>Staff no.</Th><Th>Department</Th><Th>Status</Th><Th right>Net salary</Th><Th>Salary record</Th></tr></thead>
          <tbody>
            {pg.items.map(({ user, profile, department }) => (
              <tr key={user.id} className="hover:bg-slate-50">
                <Td><Link href={`/hr/staff/${user.id}`} className="link">{user.displayName}</Link><p className="text-xs text-muted">{user.email}</p></Td>
                <Td>{profile?.staffNumber ?? "N/A"}</Td>
                <Td>{department ?? "N/A"}</Td>
                <Td className="capitalize">{profile?.employmentStatus?.replace("_", " ") ?? "N/A"}{!user.isActive && <> <Badge tone="danger">Inactive</Badge></>}{!user.entraOid && !user.isDevFixture && <> <Badge>Not signed in yet</Badge></>}</Td>
                <Td right><Money value={profile?.monthlyNet} /></Td>
                <Td>{profile?.salarySource === "hr_verified" || profile?.salarySource === "payroll" ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination data={pg} base="/hr/staff" params={{ q }} label="staff" />
      </Card>
    </>
  );
}
