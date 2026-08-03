/**
 * A failed shoal request. Carries the HTTP status so callers can distinguish
 * "try again later" from "this will never succeed", which matters because the
 * outbox is drained in a loop and a retried-forever error stalls sync.
 */
export declare class ShoalError extends Error {
    readonly status: number;
    readonly body: string;
    /** Retrying cannot help: the server refused on grounds that will not change. */
    readonly terminal: boolean;
    /** From `Retry-After`, when the server sent one. */
    readonly retryAfterMs?: number;
    constructor(status: number, method: string, path: string, body: string, retryAfterMs?: number);
    /** The batch was too large. The caller should send fewer ops, not give up. */
    get tooLarge(): boolean;
    get rateLimited(): boolean;
}
/** Thrown when a network call never reached the server. */
export declare class ShoalNetworkError extends Error {
    readonly cause: unknown;
    constructor(method: string, path: string, cause: unknown);
}
/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Returns
 * undefined for anything unparseable, which the caller treats as "no hint".
 */
export declare function parseRetryAfter(value: string | null, nowMs: number): number | undefined;
