import type { Executor } from "@/db";
import { auditLogs } from "@/db/schema";
import type { Actor } from "./actor";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

const REDACT = new Set(["bankAccountNumberEnc", "tokenHash", "storageKey"]);

function scrub(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(scrub);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.has(k) ? "[redacted]" : scrub(v)]));
}

/** Append an immutable audit record. Call inside the same DB transaction as the change it describes. */
export async function audit(db: Executor, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: actor?.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary ?? null,
    before: scrub(entry.before) as never,
    after: scrub(entry.after) as never,
    ipAddress: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
  });
}
