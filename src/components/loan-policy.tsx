import { ChevronDown } from "lucide-react";
import { RichText } from "./rich-text";

/** The staff loan policy, in a panel the applicant can open and close while applying. */
export function LoanPolicyPanel({ title, body, open, className }: { title: string; body: string; open?: boolean; className?: string }) {
  return (
    <details open={open} className={`card group ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block text-xs text-muted">Please read before you apply.</span>
        </span>
        <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="gap-10 border-t border-line px-5 py-4 text-sm leading-relaxed text-slate-700 xl:columns-2 [&_h3]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-navy [&_section]:mb-4 [&_section]:break-inside-avoid">
        <RichText text={body} headingLevel={3} />
      </div>
    </details>
  );
}
