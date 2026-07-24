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
export class DexieShoalStorage implements ShoalStorage {
  constructor(private readonly db: Dexie) {}

  private get outbox() {
    return this.db.table<OutboxOp, string>("_shoal_outbox");
  }
  private get meta() {
    return this.db.table<{ recordId: string; hlc: string }, string>("_shoal_meta");
  }
  private get kv() {
    return this.db.table<{ key: string; value: number }, string>("_shoal_kv");
  }

  async enqueue(op: OutboxOp): Promise<void> {
    await this.outbox.put(op);
  }

  async outboxBatch(limit: number): Promise<OutboxOp[]> {
    return this.outbox.orderBy("createdAt").limit(limit).toArray();
  }

  async clearOutbox(opIds: string[]): Promise<void> {
    await this.outbox.bulkDelete(opIds);
  }

  async getHlc(recordId: string): Promise<string | undefined> {
    return (await this.meta.get(recordId))?.hlc;
  }

  async putHlc(recordId: string, hlc: string): Promise<void> {
    await this.meta.put({ recordId, hlc });
  }

  async getCursor(): Promise<number> {
    return (await this.kv.get("cursor"))?.value ?? 0;
  }

  async setCursor(seq: number): Promise<void> {
    await this.kv.put({ key: "cursor", value: seq });
  }
}
