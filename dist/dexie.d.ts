import type Dexie from "dexie";
import type { OutboxOp, ShoalStorage } from "./engine.js";
/**
 * ShoalStorage over three small tables in the app's own Dexie database, so
 * outbox writes share transactions with the data they describe.
 *
 * The app declares the tables in its next schema version:
 *
 *   db.version(N).stores({
 *     ...existing,
 *     _shoal_outbox: "opId, createdAt",
 *     _shoal_meta: "recordId",
 *     _shoal_kv: "key",
 *   });
 */
export declare class DexieShoalStorage implements ShoalStorage {
    private readonly db;
    constructor(db: Dexie);
    private get outbox();
    private get meta();
    private get kv();
    enqueue(op: OutboxOp): Promise<void>;
    outboxBatch(limit: number): Promise<OutboxOp[]>;
    clearOutbox(opIds: string[]): Promise<void>;
    getHlc(recordId: string): Promise<string | undefined>;
    putHlc(recordId: string, hlc: string): Promise<void>;
    getCursor(): Promise<number>;
    setCursor(seq: number): Promise<void>;
}
