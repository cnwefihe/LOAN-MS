import Link from "next/link";
import { SearchFilter } from "@/components/search-filter";
import { Money, StatusBadge, DateText, Table, Th, Td, EmptyState } from "./ui";

export interface QueueRow {
  app: { id: string; reference: string; status: string; requestedAmount: string; tenorMonths: number; submittedAt: Date | null; isEscalated: boolean; currentApprovalLevel: number };
  applicantName: string;
  productName: string;
  staffNumber: string | null;
  department: string | null;
  approverTitle?: "hod" | "line_manager" | null;
}

/** stageName: names the approval level of applications awaiting approval (Line Manager, HR Director, Bursar). */
export function QueueTable({ rows, hrefBase, empty = "Nothing in this queue.", stageName }: { rows: QueueRow[]; hrefBase: string; empty?: string; stageName?: (level: number, title?: "hod" | "line_manager" | null) => string }) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <Table caption="Application queue">
      <thead><tr><Th>Reference</Th><Th>Applicant</Th><Th>Department</Th><Th>Product</Th><Th right>Amount</Th><Th right>Months</Th><Th>Status</Th><Th>Submitted</Th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.app.id} className="hover:bg-slate-50">
            <Td><Link href={`${hrefBase}/${r.app.id}`} className="link">{r.app.reference}</Link></Td>
            <Td>{r.applicantName}<p className="text-xs text-muted">{r.staffNumber ?? "No staff no."}</p></Td>
            <Td>{r.department ?? "N/A"}</Td>
            <Td>{r.productName}</Td>
            <Td right><Money value={r.app.requestedAmount} /></Td>
            <Td right>{r.app.tenorMonths}</Td>
            <Td><StatusBadge status={r.app.status} />{r.app.status === "pending_approval" && stageName && <p className="text-xs text-muted">{stageName(r.app.currentApprovalLevel || 1, r.approverTitle)}</p>}</Td>
            <Td><DateText value={r.app.submittedAt} /></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Search and filter a queue. Filtering only changes what is listed; statuses move on their own as each person acts. */
export function QueueFilters({ action, q, status, statuses }: { action: string; q?: string; status?: string; statuses: { value: string; label: string }[] }) {
  return <SearchFilter action={action} q={q} placeholder="Search reference, name or staff number" filter={{ name: "status", value: status, options: statuses }} />;
}
