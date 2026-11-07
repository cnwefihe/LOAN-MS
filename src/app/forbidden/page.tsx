import Link from "next/link";

export const metadata = { title: "Access denied" };

export default function Forbidden() {
  return (
    <main id="main" className="grid min-h-screen place-items-center p-6">
      <div className="card max-w-md p-8 text-center">
        <p className="text-sm font-semibold text-danger">Error 403: access denied</p>
        <h1 className="mt-2 text-xl font-semibold">You do not have permission to view this page</h1>
        <p className="mt-2 text-sm text-muted">If you require access, please contact the system administrator.</p>
        <Link href="/dashboard" className="btn-primary mt-6">Back to dashboard</Link>
      </div>
    </main>
  );
}
