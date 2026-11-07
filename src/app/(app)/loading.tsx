/** Skeleton shown while a page's data loads, so navigation responds immediately on slow connections. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="mb-6 space-y-2">
        <div className="h-7 w-64 max-w-full animate-pulse rounded bg-line" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-line/70" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card h-24 animate-pulse bg-surface" />)}
      </div>
      <div className="card h-72 animate-pulse" />
    </div>
  );
}
