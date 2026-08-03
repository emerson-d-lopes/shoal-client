/**
 * A failed shoal request. Carries the HTTP status so callers can distinguish
 * "try again later" from "this will never succeed", which matters because the
 * outbox is drained in a loop and a retried-forever error stalls sync.
 */
export class ShoalError extends Error {
  readonly status: number;
  readonly body: string;
  /** Retrying cannot help: the server refused on grounds that will not change. */
  readonly terminal: boolean;
  /** From `Retry-After`, when the server sent one. */
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    method: string,
    path: string,
    body: string,
    retryAfterMs?: number,
  ) {
    super(`shoal ${status} on ${method} ${path}: ${body.slice(0, 200)}`);
    this.name = "ShoalError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.terminal = TERMINAL_STATUSES.has(status);
  }

  /** The batch was too large. The caller should send fewer ops, not give up. */
  get tooLarge(): boolean {
    return this.status === 413;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * 400 and 403 mean the request itself is unacceptable, and 507 means the
 * server is full. None of them change on their own, so a retry loop that
 * treats them as transient never terminates.
 */
const TERMINAL_STATUSES = new Set([400, 401, 403, 507]);

/** Thrown when a network call never reached the server. */
export class ShoalNetworkError extends Error {
  readonly cause: unknown;
  constructor(method: string, path: string, cause: unknown) {
    super(`shoal request failed on ${method} ${path}: ${String(cause)}`);
    this.name = "ShoalNetworkError";
    this.cause = cause;
  }
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Returns
 * undefined for anything unparseable, which the caller treats as "no hint".
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // A value that is a number is a delay in seconds and nothing else. Falling
  // through to the date branch would accept "-5", which Date.parse resolves.
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined;
  }
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - nowMs);
  return undefined;
}
