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
export class DexieShoalStorage {
    db;
    constructor(db) {
        this.db = db;
    }
    get outbox() {
        return this.db.table("_shoal_outbox");
    }
    get meta() {
        return this.db.table("_shoal_meta");
    }
    get kv() {
        return this.db.table("_shoal_kv");
    }
    async enqueue(op) {
        await this.outbox.put(op);
    }
    async outboxBatch(limit) {
        return this.outbox.orderBy("createdAt").limit(limit).toArray();
    }
    async clearOutbox(opIds) {
        await this.outbox.bulkDelete(opIds);
    }
    async getHlc(recordId) {
        return (await this.meta.get(recordId))?.hlc;
    }
    async putHlc(recordId, hlc) {
        await this.meta.put({ recordId, hlc });
    }
    async getCursor() {
        return (await this.kv.get("cursor"))?.value ?? 0;
    }
    async setCursor(seq) {
        await this.kv.put({ key: "cursor", value: seq });
    }
}
