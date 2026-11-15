import { entraConfig } from "@/lib/auth/entra";
import { getTransport } from "@/server/email";
import { payrollProvider } from "@/server/integrations/payroll";

/** What the system is connected to. Reports only what is actually configured. */
export function connectionStatus() {
  return [
    { name: "Microsoft Entra ID SSO", ok: !!entraConfig(), needs: "ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, APP_BASE_URL" },
    { name: "Email (Microsoft 365 via Graph)", ok: !!getTransport(), needs: "EMAIL_TRANSPORT=graph, EMAIL_SENDER_ADDRESS, EMAIL_GRAPH_* (or ENTRA_*) credentials with Mail.Send application permission. Test from Email outbox." },
    { name: "Production database", ok: !!process.env.DATABASE_URL, needs: "DATABASE_URL (PostgreSQL 15+)" },
    { name: "Encryption key (at rest)", ok: !!process.env.DATA_ENCRYPTION_KEY, needs: "DATA_ENCRYPTION_KEY (32-byte base64, from Key Vault)" },
    { name: "Scheduled servicing", ok: !!process.env.CRON_SECRET, needs: "CRON_SECRET + hourly POST /api/cron/servicing (the check runs as often as set in Settings) and POST /api/cron/reminders every 5 minutes" },
    { name: "Payroll API", ok: !!payrollProvider(), needs: "PAYROLL_API_BASE_URL + PAYROLL_API_KEY (contract in src/server/integrations/payroll.ts); CSV import works without it" },
  ];
}
