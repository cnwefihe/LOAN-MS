import { Download } from "lucide-react";

/** Printable application and guarantor forms, filled from the record. */
export function FormDownloads({ applicationId, status }: { applicationId: string; status: string }) {
  if (status === "draft") return null;
  return (
    <>
      <a href={`/api/applications/${applicationId}/form`} className="btn-secondary h-8 px-3 text-xs"><Download aria-hidden className="h-3.5 w-3.5" /> Application form</a>
      <a href={`/api/applications/${applicationId}/form?type=guarantor`} className="btn-secondary h-8 px-3 text-xs"><Download aria-hidden className="h-3.5 w-3.5" /> Guarantor&apos;s form</a>
    </>
  );
}
