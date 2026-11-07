/**
 * Dependency-free SVG charts (server-rendered). Single-hue series in institutional blue
 * (validated: lightness band, chroma, ≥3:1 contrast on white); targets/annotations in ink.
 * Every chart ships a hover tooltip per mark (<title>) and a data-table view.
 */
import { formatNaira } from "@/lib/finance/money";

/** Follows the administrator-configured brand colour. */
const SERIES = "var(--color-brand)";
const TARGET = "#B45309";
const GRID = "#E2E8F0";
const MUTED = "#5F6F86";

function compact(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}bn`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return n.toFixed(0);
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

/** Collected (bars) vs expected (target ticks) per month. One axis, one hue. */
export function CollectionChart({ data, title }: { data: { month: string; expected: string; collected: string; rate: number | null }[]; title: string }) {
  const W = 720, H = 260, L = 48, R = 12, T = 16, B = 32;
  const max = niceMax(Math.max(...data.flatMap((d) => [Number(d.expected), Number(d.collected)]), 0));
  const bw = (W - L - R) / data.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="font-medium text-ink">{title}</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERIES }} /> Collected (confirmed)</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-0.5 w-4" style={{ background: TARGET }} /> Expected (scheduled)</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. Table view follows.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill={MUTED}>{compact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = L + i * bw;
          const c = Number(d.collected), e = Number(d.expected);
          const barW = Math.max(6, Math.min(28, bw * 0.5));
          const bx = x + (bw - barW) / 2;
          const h = Math.max(0, H - B - y(c));
          return (
            <g key={d.month}>
              <title>{`${d.month}: collected ${formatNaira(d.collected)} of ${formatNaira(d.expected)} expected${d.rate !== null ? ` (${d.rate}%)` : ""}`}</title>
              <rect x={x} y={T} width={bw} height={H - T - B} fill="transparent" />
              {c > 0 && <path d={`M${bx},${H - B} V${H - B - h + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, h)},-${Math.min(4, h)} H${bx + barW - Math.min(4, h)} q${Math.min(4, h)},0 ${Math.min(4, h)},${Math.min(4, h)} V${H - B} Z`} style={{ fill: SERIES }} />}
              {e > 0 && <line x1={bx - 4} x2={bx + barW + 4} y1={y(e)} y2={y(e)} stroke={TARGET} strokeWidth={2} strokeLinecap="round" />}
              <text x={x + bw / 2} y={H - B + 14} textAnchor="middle" fontSize={10} fill={MUTED}>{d.month.slice(2)}</text>
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={MUTED} strokeWidth={1} />
      </svg>
    </figure>
  );
}

/** Horizontal bars for a single measure across categories, direct-labelled. */
export function BarList({ data, title }: { data: { label: string; value: string; note?: string }[]; title: string }) {
  const max = Math.max(...data.map((d) => Number(d.value)), 1);
  return (
    <figure>
      <figcaption className="mb-3 text-xs font-medium text-ink">{title}</figcaption>
      <ul className="space-y-2.5">
        {data.map((d) => (
          <li key={d.label} title={`${d.label}: ${formatNaira(d.value)}${d.note ? ` · ${d.note}` : ""}`}>
            <div className="mb-1 flex justify-between gap-2 text-xs"><span className="truncate text-ink">{d.label}</span><span className="tabular text-muted">{formatNaira(d.value)}</span></div>
            <div className="h-2.5 rounded-sm bg-slate-100"><div className="h-2.5 rounded-r-[4px]" style={{ width: `${(Number(d.value) / max) * 100}%`, background: SERIES, minWidth: Number(d.value) > 0 ? 4 : 0 }} /></div>
          </li>
        ))}
      </ul>
    </figure>
  );
}
