import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieShoalStorage } from "../src/dexie.js";
import type { OutboxOp } from "../src/engine.js";

let counter = 0;

function newDb(): Dexie {
  const db = new Dexie(`shoal-test-${counter++}`);
  db.version(1).stores({
    _shoal_outbox: "opId, createdAt",
    _shoal_meta: "recordId",
    _shoal_kv: "key",
  });
  return db;
}

function op(opId: string, recordId: string, createdAt: number): OutboxOp {
  return { opId, recordId, hlc: `h-${opId}`, payload: "{}", createdAt };
}

describe("DexieShoalStorage", () => {
  let db: Dexie;

  beforeEach(async () => {
    db = newDb();
    await db.open();
  });

  it("round-trips the cursor and record metadata", async () => {
    const store = new DexieShoalStorage(db, "mnemonic");
    expect(await store.getCursor()).toBe(0);
    await store.setCursor(42);
    expect(await store.getCursor()).toBe(42);

    expect(await store.getHlc("card/1")).toBeUndefined();
    await store.putHlc("card/1", "stamp");
    expect(await store.getHlc("card/1")).toBe("stamp");
  });

  it("drains the outbox oldest first", async () => {
    const store = new DexieShoalStorage(db, "mnemonic");
    await store.enqueue(op("c", "r/3", 300));
    await store.enqueue(op("a", "r/1", 100));
    await store.enqueue(op("b", "r/2", 200));

    const batch = await store.outboxBatch(10);
    expect(batch.map((o) => o.opId)).toEqual(["a", "b", "c"]);

    await store.clearOutbox(["a", "b"]);
    expect((await store.outboxBatch(10)).map((o) => o.opId)).toEqual(["c"]);
  });

  it("keeps two collections in one database fully separate", async () => {
    // Sharing a cursor is silent data loss: whichever collection syncs second
    // skips every op below the other's position and never sees it again.
    const a = new DexieShoalStorage(db, "mnemonic");
    const b = new DexieShoalStorage(db, "habits");

    await a.setCursor(100);
    expect(await b.getCursor()).toBe(0);
    await b.setCursor(7);
    expect(await a.getCursor()).toBe(100);

    // The same record id in two collections is two different records.
    await a.putHlc("card/1", "from-a");
    await b.putHlc("card/1", "from-b");
    expect(await a.getHlc("card/1")).toBe("from-a");
    expect(await b.getHlc("card/1")).toBe("from-b");

    // And neither drains the other's queued ops.
    await a.enqueue(op("a1", "r/1", 1));
    await b.enqueue(op("b1", "r/1", 2));
    expect((await a.outboxBatch(10)).map((o) => o.opId)).toEqual(["a1"]);
    expect((await b.outboxBatch(10)).map((o) => o.opId)).toEqual(["b1"]);
  });

  it("adopts a store written before keys were namespaced", async () => {
    // Exactly what an existing install looks like: a bare "cursor" key,
    // un-prefixed record ids, and outbox rows with no collection field.
    await db.table("_shoal_kv").put({ key: "cursor", value: 55 });
    await db.table("_shoal_meta").put({ recordId: "card/1", hlc: "old-stamp" });
    await db.table("_shoal_outbox").put(op("legacy", "card/2", 10));

    const store = new DexieShoalStorage(db, "mnemonic");

    expect(await store.getCursor()).toBe(55);
    expect(await store.getHlc("card/1")).toBe("old-stamp");
    const batch = await store.outboxBatch(10);
    expect(batch.map((o) => o.opId)).toEqual(["legacy"]);

    // The old un-namespaced keys are gone, so a second collection added later
    // cannot inherit them.
    expect(await db.table("_shoal_kv").get("cursor")).toBeUndefined();
    const other = new DexieShoalStorage(db, "habits");
    expect(await other.getCursor()).toBe(0);
    expect(await other.getHlc("card/1")).toBeUndefined();
  });

  it("upgrades only once and does not clobber a newer cursor", async () => {
    await db.table("_shoal_kv").put({ key: "cursor", value: 55 });
    const store = new DexieShoalStorage(db, "mnemonic");
    expect(await store.getCursor()).toBe(55);

    await store.setCursor(90);
    // A fresh instance over the same database must not re-run the migration
    // and drag the cursor back to the legacy value.
    const again = new DexieShoalStorage(db, "mnemonic");
    expect(await again.getCursor()).toBe(90);
  });

  it("still works without a collection, as the original constructor did", async () => {
    const store = new DexieShoalStorage(db);
    await store.setCursor(5);
    await store.putHlc("card/1", "stamp");
    expect(await store.getCursor()).toBe(5);
    expect(await store.getHlc("card/1")).toBe("stamp");
    expect(await db.table("_shoal_kv").get("cursor")).toEqual({ key: "cursor", value: 5 });
  });
});
