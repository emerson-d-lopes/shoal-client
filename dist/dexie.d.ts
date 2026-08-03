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
 *
 * Every key is namespaced by collection. Two collections sharing one database
 * would otherwise share a single cursor, and the second to sync would skip
 * every op below the first one's position and never see it again.
 *
 * Stores written before this namespacing are upgraded in place on first use,
 * so no app schema change is needed.
 */
export declare class DexieShoalStorage implements ShoalStorage {
    private readonly db;
    private readonly collection;
    private upgrade?;
    constructor(db: Dexie, collection?: string);
    private get outbox();
    private get meta();
    private get kv();
    private metaKey;
    private cursorKey;
    private versionKey;
    /**
     * Moves un-namespaced keys written by earlier versions under this
     * collection. Runs at most once per instance and is safe to interleave with
     * normal use, because it only ever renames keys this collection would own.
     */
    private ensureUpgraded;
    enqueue(op: OutboxOp): Promise<void>;
    outboxBatch(limit: number): Promise<OutboxOp[]>;
    clearOutbox(opIds: string[]): Promise<void>;
    getHlc(recordId: string): Promise<string | undefined>;
    putHlc(recordId: string, hlc: string): Promise<void>;
    getCursor(): Promise<number>;
    setCursor(seq: number): Promise<void>;
}
