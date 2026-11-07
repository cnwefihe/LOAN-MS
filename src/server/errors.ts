/** Errors whose message is safe to show to the user. Anything else is logged and replaced with a generic message. */
export class DomainError extends Error {
  readonly expose = true;
  constructor(message: string, readonly code = "domain_error") {
    super(message);
    this.name = "DomainError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You are not authorised to perform this action.") {
    super(message, "forbidden");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends DomainError {
  constructor(what = "Record") {
    super(`${what} not found.`, "not_found");
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message = "This record was changed by someone else. Refresh and try again.") {
    super(message, "conflict");
    this.name = "ConflictError";
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super("Your session has expired. Please sign in again.", "unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message);
}

/** Postgres unique violations (23505) surface as friendly conflicts. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
