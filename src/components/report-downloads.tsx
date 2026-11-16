import { Download } from "lucide-react";
import { Card } from "@/components/ui";

const FORMAT_LABEL = { pdf: "PDF", xlsx: "Excel", csv: "CSV" } as const;
type Format = keyof typeof FORMAT_LABEL;

/** The one way to download a report: a joined PDF, Excel and CSV control, used on every page. */
export function ReportDownloads({ title, href, label, formats = ["pdf", "xlsx", "csv"] }: {
  title: string;
  href: (format: Format) => string;
  /** Shown beside the control when the page does not already name the report. */
  label?: boolean;
  formats?: readonly Format[];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {label && <span className="text-xs font-semibold text-navy">{title}</span>}
      <span role="group" aria-label={`Download ${title}`} className="relative inline-flex items-stretch overflow-hidden rounded-lg border border-line bg-white shadow-sm">
        <span aria-hidden className="flex items-center border-r border-line bg-brand-50 px-2 text-navy"><Download className="h-3.5 w-3.5" /></span>
        {formats.map((f, i) => (
          <a key={f} href={href(f)} className={`relative flex h-8 items-center px-3 text-xs font-semibold text-navy hover:bg-brand-50 ${i ? "border-l border-line" : ""}`}>
            {FORMAT_LABEL[f]}<span className="sr-only">: {title}</span>
          </a>
        ))}
      </span>
    </span>
  );
}

/** Month picker with that month's downloads on the same row. */
export function MonthToolbar({ month, max, children }: { month: string; max?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-6" bodyClassName="p-4">
      <form method="get" className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="month" className="text-sm font-medium text-slate-700">Month</label>
        <input id="month" name="month" type="month" max={max} defaultValue={month} className="input h-9 w-auto" />
        <button className="btn-primary">Apply</button>
        <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">{children}</span>
      </form>
    </Card>
  );
}
