import { describe, expect, it } from "vitest";
import { ShoalSync, type OutboxOp, type ShoalStorage } from "../src/engine.js";
import { SyncKeys, b64url, b64urlDecode } from "../src/keys.js";
import { Hlc } from "../src/hlc.js";

const PHRASE = "warm answer profit skate gift prison brother wild jar sing protect invest";

class MemoryStorage implements ShoalStorage {
  outbox: OutboxOp[] = [];
  meta = new Map<string, string>();
  cursor = 0;

  async enqueue(op: OutboxOp) {
    this.outbox.push(op);
  }
  async outboxBatch(limit: number) {
    return this.outbox.slice(0, limit);
  }
  async clearOutbox(opIds: string[]) {
    this.outbox = this.outbox.filter((o) => !opIds.includes(o.opId));
  }
  async getHlc(recordId: string) {
    return this.meta.get(recordId);
  }
  async putHlc(recordId: string, hlc: string) {
    this.meta.set(recordId, hlc);
  }
  async getCursor() {
    return this.cursor;
  }
  async setCursor(seq: number) {
    this.cursor = seq;
  }
}

/** Minimal in-memory shoal server honoring the wire format (no auth checks). */
function fakeServer() {
  const log: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const u = new URL(String(url));
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      for (const op of body.ops) {
        if (!log.some((o) => o.op_id === op.op_id)) log.push({ ...op, seq: log.length + 1 });
      }
      return json({ results: [], head: log.length });
    }
    const since = Number(u.searchParams.get("since") ?? 0);
    return json({ ops: log.filter((o) => o.seq > since), head: log.length });
  }) as unknown as typeof fetch;
  return { log, fetchImpl };
}

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

function makeSync(server: ReturnType<typeof fakeServer>, nodeId: number, applied: Record<string, unknown>) {
  return new ShoalSync({
    serverUrl: "http://fake",
    mnemonic: PHRASE,
    collection: "test",
    nodeId,
    storage: new MemoryStorage(),
    apply: async (recordId, body) => {
      applied[recordId] = body;
    },
    fetchImpl: server.fetchImpl,
  });
}

describe("ShoalSync", () => {
  it("pushes encrypted ops and another device pulls and applies them", async () => {
    const server = fakeServer();
    const appliedA: Record<string, unknown> = {};
    const appliedB: Record<string, unknown> = {};
    const deviceA = makeSync(server, 1, appliedA);
    const deviceB = makeSync(server, 2, appliedB);

    await deviceA.record("habit/h1", { name: "run", createdAt: 1 });
    await deviceA.sync();

    expect(server.log).toHaveLength(1);
    // Server-side payload is ciphertext, not JSON.
    expect(() => JSON.parse(atob(server.log[0].payload))).toThrow();

    await deviceB.sync();
    expect(appliedB["habit/h1"]).toEqual({ name: "run", createdAt: 1 });
    // A's own echo is not re-applied.
    expect(appliedA["habit/h1"]).toBeUndefined();
  });

  it("LWW: causally newest wins regardless of arrival order", async () => {
    const server = fakeServer();
    const keys = SyncKeys.fromMnemonic(PHRASE);
    const record = "habit/conflict";
    const enc = (body: unknown) =>
      b64url(keys.encrypt(new TextEncoder().encode(JSON.stringify(body)), "test", record));

    // Newer op arrives FIRST in the log, older second.
    server.log.push(
      { op_id: "n", collection: "test", record_id: record, hlc: Hlc.encode(2000, 0, 9), payload: enc({ name: "newer" }), seq: 1 },
      { op_id: "o", collection: "test", record_id: record, hlc: Hlc.encode(1000, 0, 8), payload: enc({ name: "older" }), seq: 2 },
    );

    const applied: Record<string, unknown> = {};
    const device = makeSync(server, 3, applied);
    await device.sync();
    expect(applied[record]).toEqual({ name: "newer" });
  });

  it("undecryptable ops are skipped without wedging the cursor", async () => {
    const server = fakeServer();
    server.log.push(
      { op_id: "bad", collection: "test", record_id: "r/1", hlc: Hlc.encode(1000, 0, 1), payload: b64url(new Uint8Array(40)), seq: 1 },
    );
    const applied: Record<string, unknown> = {};
    const device = makeSync(server, 4, applied);
    await device.sync();
    expect(applied["r/1"]).toBeUndefined();

    await device.record("r/2", { ok: true });
    await device.sync();
    expect(server.log).toHaveLength(2);
  });

  it("outbox survives a failed push and drains on the next sync", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const storage = new MemoryStorage();
    const applied: Record<string, unknown> = {};
    const offline = new ShoalSync({
      serverUrl: "http://fake",
      mnemonic: PHRASE,
      collection: "test",
      nodeId: 5,
      storage,
      apply: async (r, b) => {
        applied[r] = b;
      },
      fetchImpl: failing,
    });

    await offline.record("habit/h9", { name: "stretch" });
    await expect(offline.sync()).rejects.toThrow("network down");
    expect(storage.outbox).toHaveLength(1);

    const server = fakeServer();
    const online = new ShoalSync({
      serverUrl: "http://fake",
      mnemonic: PHRASE,
      collection: "test",
      nodeId: 5,
      storage,
      apply: async (r, b) => {
        applied[r] = b;
      },
      fetchImpl: server.fetchImpl,
    });
    await online.sync();
    expect(storage.outbox).toHaveLength(0);
    expect(server.log).toHaveLength(1);
  });
});
