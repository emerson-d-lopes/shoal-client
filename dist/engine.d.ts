export interface OutboxOp {
    opId: string;
    recordId: string;
    hlc: string;
    /** Plaintext JSON string; encrypted at push time. */
    payload: string;
    createdAt: number;
    /** Which collection the op belongs to. Absent on rows written before v0.2. */
    collection?: string;
}
/**
 * Storage the host app provides (the Dexie adapter implements this over three
 * extra tables in the app's own database). Outbox writes must happen in the
 * same transaction as the data change they describe.
 *
 * Every method is scoped to one collection. An implementation shared between
 * two collections must namespace its keys, or the two will overwrite each
 * other's cursor and record metadata.
 */
export interface ShoalStorage {
    enqueue(op: OutboxOp): Promise<void>;
    outboxBatch(limit: number): Promise<OutboxOp[]>;
    clearOutbox(opIds: string[]): Promise<void>;
    getHlc(recordId: string): Promise<string | undefined>;
    putHlc(recordId: string, hlc: string): Promise<void>;
    getCursor(): Promise<number>;
    setCursor(seq: number): Promise<void>;
}
/** What the server removed in response to a compaction request. */
export interface CompactResult {
    /** Ops dropped by this call. */
    removed: number;
    /** Ops still stored for this user, across every collection. */
    remaining: number;
    /** Unchanged by compaction. */
    head: number;
}
/** Why an incoming op could not be turned back into a record. */
export interface UndecryptableOp {
    recordId: string;
    collection: string;
    hlc: string;
    reason: "decrypt" | "parse";
    error: unknown;
}
export interface ShoalConfig {
    serverUrl: string;
    mnemonic: string;
    collection: string;
    /** Stable per-install id; persist it next to the cursor. */
    nodeId: number;
    storage: ShoalStorage;
    /**
     * Applies one remote record to the app database. `body` is the decrypted
     * op payload; route on the recordId prefix. Called only after the LWW gate
     * (incoming hlc newer than the stored one), and never for the app's own
     * echoed ops. Must not re-enter record().
     */
    apply: (recordId: string, body: unknown, hlc: string) => Promise<void>;
    fetchImpl?: typeof fetch;
    /**
     * Called when an op arrives that this client cannot read. The op is skipped
     * and its hlc recorded either way, so sync does not stall on it, but the
     * record silently stops tracking that write. Wrong mnemonic is the usual
     * cause; a client version mismatch is the other.
     */
    onUndecryptable?: (info: UndecryptableOp) => void;
    /** Called for every error the live-sync loop absorbs. */
    onError?: (error: unknown) => void;
    /** Per-op ciphertext ceiling. Must not exceed the server's. */
    maxPayloadBytes?: number;
    /** Serialized bytes per push. Must stay under the server's body limit. */
    maxBatchBytes?: number;
    /** Ops per push, before the byte budget trims it further. */
    maxBatchOps?: number;
    /** Backoff floor and ceiling for the live-sync loop. */
    minBackoffMs?: number;
    maxBackoffMs?: number;
    /**
     * How often `start()` compacts, in milliseconds. Off by default.
     *
     * Only set this if the collection merges last-writer-wins, which is what
     * `apply` does when it overwrites a record. A collection whose history is
     * meaningful, appended and never superseded, loses data to compaction.
     */
    autoCompactEveryMs?: number;
}
/** Matches the server's own per-op ceiling, measured on decoded bytes. */
export declare const DEFAULT_MAX_PAYLOAD_BYTES: number;
/**
 * Kept under the server's 16 MiB body limit with room for JSON overhead, so
 * a large batch is trimmed here rather than bounced with a 413.
 */
export declare const DEFAULT_MAX_BATCH_BYTES: number;
export declare const DEFAULT_MAX_BATCH_OPS = 500;
/**
 * Push the outbox, pull past the cursor, merge — one instance per synced
 * collection. Every network failure throws; callers treat sync as
 * opportunistic and the app never depends on it.
 *
 * `sync()` runs one round on demand. `start()` runs rounds continuously,
 * driven by the server's poke stream, until `stop()`.
 */
export declare class ShoalSync {
    private readonly cfg;
    private readonly keys;
    private readonly hlc;
    private readonly fetchImpl;
    private readonly maxPayloadBytes;
    private readonly maxBatchBytes;
    private readonly minBackoffMs;
    private readonly maxBackoffMs;
    /** Trimmed when the server rejects a batch as too large, restored on success. */
    private batchOps;
    private readonly configuredBatchOps;
    private running;
    private inFlight?;
    private again;
    private abort?;
    private wake?;
    private listenersAttached;
    /** Zero means "never", so the first live round compacts if it is enabled. */
    private lastCompactAt;
    constructor(cfg: ShoalConfig);
    get publicKeyB64(): string;
    /** Whether the live-sync loop is running. */
    get live(): boolean;
    /**
     * Record a local write: full record state, or null for a tombstone marker.
     *
     * Oversized records are refused here rather than at push time. An op that
     * the server will always reject cannot be allowed into the outbox, because
     * the outbox drains in order and one undeliverable op blocks everything
     * queued behind it.
     */
    record(recordId: string, body: unknown): Promise<void>;
    /**
     * Ask the server to drop ops that later writes superseded.
     *
     * Compaction runs only up to this client's pull cursor, so it never removes
     * anything this client has not already seen and merged. Each record keeps
     * its newest op, which under last-writer-wins is the only one that could
     * ever be applied, so a device that never synced still converges to the
     * same state. It just skips intermediate values, which LWW discards anyway.
     *
     * Do not call this for a collection whose ops are merged append-only. Every
     * op there carries meaning that the newest one does not subsume.
     *
     * Push first, so nothing still queued locally is left as the only copy of a
     * record whose server-side history just shrank.
     */
    compact(): Promise<CompactResult>;
    /**
     * One full round: drain outbox, then pull and apply everything new.
     *
     * Concurrent callers join the round already in flight. A call that arrives
     * mid-round schedules one more round after it, so a poke that lands while
     * syncing is never lost.
     */
    sync(): Promise<void>;
    /**
     * Start live sync: an initial round, then a round on every server poke,
     * reconnecting with exponential backoff. Resolves once the loop is running;
     * it keeps running in the background until `stop()`.
     */
    start(): void;
    /** Stop live sync and abort any open poke stream. */
    stop(): void;
    private loop;
    /**
     * Compacts on the configured interval while the live loop runs. A failure
     * here is reported but not rethrown: compaction is housekeeping, and losing
     * the poke stream over it would be a worse outcome than a larger log.
     */
    private maybeCompact;
    /** Exponential with full jitter, so reconnecting clients do not synchronize. */
    private nextBackoff;
    /** Sleeps, but returns early if `stop()` is called. */
    private pause;
    /**
     * Reads the server's SSE stream and syncs on each poke.
     *
     * EventSource cannot set request headers, and every shoal request needs a
     * signature in one, so the stream is read from `fetch` and framed by hand.
     */
    private listenForPokes;
    private attachListeners;
    private detachListeners;
    /** Connectivity is back: stop waiting out the backoff and retry now. */
    private onOnline;
    private onVisible;
    /**
     * Encrypts and frames as many queued ops as fit in one request.
     *
     * The byte budget matters because the op count alone does not bound the
     * request size: 500 ops at the per-op ceiling is many times the server's
     * body limit. At least one op is always included, so a full outbox always
     * makes progress.
     */
    private packBatch;
    private pushAll;
    private pullAll;
    private apply;
    /**
     * Records the hlc of an op this client cannot read, so sync does not wedge
     * on it, and tells the app it happened. Advancing the stamp means later
     * writes to that record still apply, at the cost of losing this one.
     */
    private skipUnreadable;
    private request;
    private call;
}
