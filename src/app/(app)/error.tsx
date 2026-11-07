"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Shown inside the application shell when a page fails to load. Server details are never displayed. */
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="grid place-items-center py-16">
      <div className="card max-w-lg p-8 text-center" role="alert">
        <p className="text-sm font-semibold text-danger">Something went wrong</p>
        <h1 className="mt-2 text-xl font-semibold">This page could not be loaded</h1>
        <p className="mt-2 text-sm text-muted">No changes were saved. Please try again, or contact the Bursary quoting the reference below.</p>
        {digest && <p className="mt-3 font-mono text-xs text-muted">Reference: {digest}</p>}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button type="button" className="btn-primary" onClick={() => retry()}>Try again</button>
          <Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>
        </div>
      </div>
    </div>
  );
}
