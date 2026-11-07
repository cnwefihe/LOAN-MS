"use client";

/** Last-resort error page when the root layout itself fails. Uses inline styles because global CSS is not loaded here. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <html lang="en-GB">
      <body style={{ margin: 0, fontFamily: "'Segoe UI', system-ui, Arial, sans-serif", background: "#f5f7fa", color: "#172033" }}>
        <title>Service unavailable | Loan Management System</title>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <div role="alert" style={{ maxWidth: 460, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: 32, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>The Loan Management System is temporarily unavailable</h1>
            <p style={{ fontSize: 14, color: "#5f6f86" }}>Please try again in a few minutes. If the problem continues, contact the Bursary support desk{digest ? " and quote the reference below" : ""}.</p>
            {digest && <p style={{ fontSize: 12, color: "#5f6f86", fontFamily: "Consolas, monospace" }}>Reference: {digest}</p>}
            <button type="button" onClick={() => retry()} style={{ marginTop: 16, background: "#2e3a6e", color: "#fff", border: 0, borderRadius: 6, padding: "10px 18px", fontSize: 14, cursor: "pointer" }}>Try again</button>
          </div>
        </main>
      </body>
    </html>
  );
}
