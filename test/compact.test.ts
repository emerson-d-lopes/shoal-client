import { describe, expect, it } from "vitest";
import { ShoalSync, type OutboxOp, type ShoalStorage } from "../src/engine.js";
import { ShoalError } from "../src/errors.js";

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

function server() {
  const compactCalls: Array<{ collection: string; through: number }> = [];
  const pushed: any[] = [];
  let compactStatus = 200;

  const fetchImpl = (async (url: any, init: any) => {
    const u = new URL(String(url));
    if (u.pathname === "/v1/compact") {
      if (compactStatus !== 200) return new Response("no", { status: compactStatus });
      compactCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ removed: 3, remaining: 2, head: 5 }), { status: 200 });
    }
    if (init?.method === "POST") {
      pushed.push(...JSON.parse(init.body).ops);
      return new Response(JSON.stringify({ results: [], head: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ops: [], head: 0 }), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    compactCalls,
    pushed,
    fetchImpl,
    setCompactStatus(s: number) {
      compactStatus = s;
    },
  };
}

function make(s: ReturnType<typeof server>, storage = new MemoryStorage(), extra = {}) {
  const sync = new ShoalSync({
    serverUrl: "http://fake",
    mnemonic: PHRASE,
    collection: "mnemonic",
    nodeId: 1,
    storage,
    apply: async () => {},
    fetchImpl: s.fetchImpl,
    ...extra,
  });
  return { sync, storage };
}

describe("compact", () => {
  it("asks the server to compact only up to the local cursor", async () => {
    const s = server();
    const storage = new MemoryStorage();
    storage.cursor = 42;
    const { sync } = make(s, storage);

    const result = await sync.compact();

    // Never past the cursor: the client must not ask the server to discard
    // history it has not itself merged.
    expect(s.compactCalls).toEqual([{ collection: "mnemonic", through: 42 }]);
    expect(result).toEqual({ removed: 3, remaining: 2, head: 5 });
  });

  it("does nothing before the first sync", async () => {
    const s = server();
    const { sync } = make(s);
    const result = await sync.compact();

    expect(s.compactCalls).toHaveLength(0);
    expect(result.removed).toBe(0);
  });

  it("drains the outbox before compacting", async () => {
    // A queued write must reach the server first. Compacting while it is only
    // held locally would shrink the server's history around a record whose
    // newest version has not arrived yet.
    const s = server();
    const storage = new MemoryStorage();
    storage.cursor = 10;
    const { sync } = make(s, storage);

    await sync.record("card/1", { v: 1 });
    expect(storage.outbox).toHaveLength(1);

    await sync.compact();

    expect(s.pushed).toHaveLength(1);
    expect(storage.outbox).toHaveLength(0);
    expect(s.compactCalls).toHaveLength(1);
  });

  it("surfaces a server refusal", async () => {
    const s = server();
    s.setCompactStatus(403);
    const storage = new MemoryStorage();
    storage.cursor = 5;
    const { sync } = make(s, storage);

    await expect(sync.compact()).rejects.toThrow(ShoalError);
  });

  it("is off unless an interval is configured", async () => {
    const s = server();
    const storage = new MemoryStorage();
    storage.cursor = 9;
    const { sync } = make(s, storage);

    await sync.sync();
    expect(s.compactCalls).toHaveLength(0);
  });
});
