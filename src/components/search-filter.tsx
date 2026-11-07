import { Search } from "lucide-react";

/** The one search bar: search box, an optional filter, then Apply. Used on every list in the app. */
export function SearchFilter({ action, q, placeholder, filter, hidden }: {
  action?: string;
  q?: string;
  placeholder: string;
  filter?: { name: string; value?: string; options: { value: string; label: string }[] };
  /** Values to keep when the form is sent, such as the open tab. */
  hidden?: Record<string, string>;
}) {
  return (
    <form method="get" action={action} role="search" className={`mb-4 grid items-center gap-2.5 rounded-lg border border-line bg-canvas p-2.5 ${filter ? "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"}`}>
      {Object.entries(hidden ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="relative">
        <label htmlFor="q" className="sr-only">Search</label>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input id="q" name="q" defaultValue={q} placeholder={placeholder} className="input h-9 pl-9" />
      </div>
      {filter && (
        <div className="flex items-center gap-2">
          <label htmlFor={filter.name} className="text-sm font-medium text-slate-700">Filter</label>
          <select id={filter.name} name={filter.name} defaultValue={filter.value ?? ""} className="input h-9 min-w-0 flex-1 py-0">
            {filter.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      <button className="btn-primary h-9 px-4">Apply</button>
    </form>
  );
}
