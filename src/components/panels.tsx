import { getDb } from "@/db";
import { getWording } from "@/server/wording";
import { WORKFLOW } from "@/server/workflow";
import type { RoleCode } from "@/lib/auth/permissions";
import { Download } from "lucide-react";
import { humanise } from "@/lib/text";
import { instalmentLabel, type EligibilityResult } from "@/lib/finance/calculator";
import { DOCUMENT_CATEGORIES } from "@/server/services/documents";
import { ActionForm } from "./action-form";
import { Card, KeyValues, Money, Table, Th, Td, StatusBadge, DateText, Timeline, Badge, EmptyState } from "./ui";

export function QuoteSummary({ quote }: { quote: EligibilityResult }) {
  const q = quote.quote;
  return (
    <KeyValues columns={3} items={[
      ["Requested", <Money key="r" value={quote.requestedAmount} />],
      ["Maximum eligible (at submission)", <Money key="e" value={quote.maxEligibleAmount} />],
      [instalmentLabel(q?.periodMonths), <Money key="i" value={q?.monthlyInstalment} />],
      ["Total interest", <Money key="t" value={q?.totalInterest} />],
      ["Total repayable", <Money key="tr" value={q?.totalRepayable} />],
      ["Instalments", q?.instalmentCount ?? q?.schedule.length ?? "N/A"],
      ["Estimated completion (if disbursed when quoted)", <DateText key="ec" value={q?.estimatedCompletionDate} />],
    ]} />
  );
}

export interface DocRow { id: string; title: string; fileName: string; category: string; version: number; sizeBytes: number; createdAt: Date; isLatest?: boolean; isSystemGenerated: boolean }

export function DocumentList({ docs, emptyText = "No documents yet." }: { docs: DocRow[]; emptyText?: string }) {
  if (!docs.length) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ul className="divide-y divide-line">
      {docs.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{d.title} {d.version > 1 && <Badge>v{d.version}</Badge>} {d.isLatest === false && <Badge>superseded</Badge>}</p>
            <p className="text-xs text-muted">{DOCUMENT_CATEGORIES[d.category as keyof typeof DOCUMENT_CATEGORIES] ?? d.category} · {(d.sizeBytes / 1024).toFixed(0)} KB · <DateText value={d.createdAt} withTime />{d.isSystemGenerated ? " · system generated" : ""}</p>
          </div>
          <a href={`/api/documents/${d.id}`} className="btn-secondary h-8 px-2.5 text-xs"><Download aria-hidden className="h-3.5 w-3.5" /> Download<span className="sr-only"> {d.title}</span></a>
        </li>
      ))}
    </ul>
  );
}

export function UploadForm({ action, requirements, defaultTitle }: { action: Parameters<typeof ActionForm>[0]["action"]; requirements?: { code: string; label: string }[]; defaultTitle?: string }) {
  return (
    <ActionForm action={action} submitLabel="Upload" variant="secondary" resetOnSuccess encType="multipart/form-data">
      <div className="grid gap-3 sm:grid-cols-2">
        {requirements?.length ? (
          <div>
            <label htmlFor="requirementCode" className="label">Document type</label>
            <select id="requirementCode" name="requirementCode" className="input">
              {requirements.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              <option value="">Other supporting document</option>
            </select>
          </div>
        ) : (
          <div>
            <label htmlFor="title" className="label">Title</label>
            <input id="title" name="title" defaultValue={defaultTitle} className="input" />
          </div>
        )}
        <div>
          <label htmlFor="file" className="label">File (PDF, PNG or JPEG)</label>
          <input id="file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="input py-1.5" />
        </div>
      </div>
    </ActionForm>
  );
}

export function MessageThread({ messages }: { messages: { msg: { id: string; kind: string; body: string; createdAt: Date }; authorName: string }[] }) {
  if (!messages.length) return <p className="text-sm text-muted">No messages.</p>;
  return (
    <ul className="space-y-3">
      {messages.map(({ msg, authorName }) => (
        <li key={msg.id} className="rounded-md border border-line bg-slate-50 px-3 py-2">
          <p className="text-xs text-muted"><span className="font-medium text-ink">{authorName}</span> · {msg.kind === "correction" ? "Correction request" : msg.kind === "internal" ? "Internal note" : "Clarification"} · <DateText value={msg.createdAt} withTime /></p>
          <p className="mt-1 whitespace-pre-line text-sm">{msg.body}</p>
        </li>
      ))}
    </ul>
  );
}

export async function WorkflowHistory({ history }: { history: { t: { id: string; action: string; fromStatus: string | null; toStatus: string; actorRole: string; comment: string | null; createdAt: Date }; actorName: string }[] }) {
  const w = await getWording(await getDb());
  const role = (code: string) => (code in w.role ? w.role[code as RoleCode].name : humanise(code));
  return (
    <Timeline items={history.map(({ t, actorName }) => ({
      title: <span className="inline-flex flex-wrap items-center gap-2">{WORKFLOW[t.action]?.label ?? humanise(t.action)} <StatusBadge status={t.toStatus} /></span>,
      meta: <>{actorName} ({role(t.actorRole)}) · <DateText value={t.createdAt} withTime /></>,
      body: t.comment,
    }))} />
  );
}

export function GuarantorTable({ guarantors, assessments, hideEmail }: {
  /** Applicants see their guarantors' names only. */
  hideEmail?: boolean;
  guarantors: { g: { id: string; status: string; guaranteedAmount: string; invitedAt: Date; respondedAt: Date | null; responseComment: string | null; agreementVersion: number | null }; user: { displayName: string; email: string } }[];
  assessments?: { applicationGuarantorId: string; outcome: string; existingExposure: string }[];
}) {
  if (!guarantors.length) return <EmptyState title="No guarantors" description="Guarantors are invited when the application is submitted." />;
  return (
    <Table caption="Guarantors">
      <thead><tr><Th>Guarantor</Th><Th right>Amount guaranteed</Th><Th>Status</Th><Th>Responded</Th>{assessments && <Th>Human Resources assessment</Th>}</tr></thead>
      <tbody>
        {guarantors.map(({ g, user }) => {
          const a = assessments?.find((x) => x.applicationGuarantorId === g.id);
          return (
            <tr key={g.id}>
              <Td><p className="font-medium">{user.displayName}</p>{!hideEmail && <p className="text-xs text-muted">{user.email}</p>}{g.responseComment && <p className="mt-1 text-xs italic text-muted">“{g.responseComment}”</p>}</Td>
              <Td right><Money value={g.guaranteedAmount} /></Td>
              <Td><StatusBadge status={g.status} />{g.agreementVersion && <p className="mt-1 text-xs text-muted">Agreement v{g.agreementVersion}</p>}</Td>
              <Td><DateText value={g.respondedAt} withTime /></Td>
              {assessments && <Td>{a ? <><StatusBadge status={a.outcome} /><p className="mt-1 text-xs text-muted">Exposure then: <Money value={a.existingExposure} /></p></> : <span className="text-xs text-muted">Not assessed</span>}</Td>}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
