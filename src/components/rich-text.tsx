/** **bold** inside a line. */
function Inline({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/).map((part, i) => part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="text-ink">{part.slice(2, -2)}</strong> : part)}</>;
}

/**
 * Plain text to HTML: "## " lines are headings, "- " lines are list items, lines with " | " are table rows
 * (the first is the header), and blank lines separate paragraphs.
 */
export function RichText({ text, headingLevel = 2 }: { text: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 3 ? "h3" : "h2";
  return text.replace(/\r/g, "").split(/\n{2,}/).map((block, i) => {
    const lines = block.split("\n").filter(Boolean);
    const heading = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : null;
    const items = lines.length && lines.every((l) => l.startsWith("- ")) ? lines.map((l) => l.slice(2)) : null;
    const rows = !items && lines.length > 1 && lines.every((l) => l.includes(" | ")) ? lines.map((l) => l.split(" | ").map((c) => c.trim())) : null;
    return (
      <section key={i}>
        {heading && <H>{heading}</H>}
        {rows ? (
          <div className="overflow-x-auto rounded-md border border-line" role="region" aria-label={heading ?? "Table"} tabIndex={0}>
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50"><tr>{rows[0].map((c) => <th key={c} scope="col" className="border-b border-line px-3 py-2 font-semibold text-ink">{c}</th>)}</tr></thead>
              <tbody>{rows.slice(1).map((r, j) => <tr key={j} className="align-top">{r.map((c, k) => <td key={k} className={`border-b border-line px-3 py-2 ${k === 0 ? "font-medium text-ink" : ""}`}><Inline text={c} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : items ? <ul className="list-disc space-y-1 pl-5">{items.map((x, j) => <li key={j}><Inline text={x} /></li>)}</ul>
          : lines.length > 0 && <p><Inline text={lines.join(" ")} /></p>}
      </section>
    );
  });
}
