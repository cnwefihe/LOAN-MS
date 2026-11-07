import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-screen place-items-center p-6">
      <div className="card max-w-md p-8 text-center">
        <p className="text-sm font-semibold text-muted">404</p>
        <h1 className="mt-2 text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The record may not exist, or you may not have access to it.</p>
        <Link href="/dashboard" className="btn-primary mt-6">Back to dashboard</Link>
      </div>
    </main>
  );
}
