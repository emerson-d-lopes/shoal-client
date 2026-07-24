export interface OutboxOp {
    opId: string;
    recordId: string;
    hlc: string;
    /** Plaintext JSON string; encrypted at push time. */
    payload: string;
    createdAt: number;
}
/**
 * Storage the host app provides (the Dexie adapter implements this over two
 * extra tables in the app's own database). Outbox writes must happen in the
 * same transaction as the data change they describe.
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
}
/**
 * Push the outbox, pull past the cursor, merge — one class per synced app.
 * Every network failure throws; callers treat sync as opportunistic and the
 * app never depends on it.
 */
export declare class ShoalSync {
    private readonly cfg;
    private readonly keys;
    private readonly hlc;
    private readonly fetchImpl;
    constructor(cfg: ShoalConfig);
    get publicKeyB64(): string;
    /** Record a local write: full record state, or null for a tombstone marker. */
    record(recordId: string, body: unknown): Promise<void>;
    /** One full round: drain outbox, then pull and apply everything new. */
    sync(): Promise<void>;
    private pushAll;
    private pullAll;
    private apply;
    private call;
}
