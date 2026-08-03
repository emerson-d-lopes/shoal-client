import { describe, expect, it } from "vitest";
import {
  ShoalSync,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type OutboxOp,
  type ShoalConfig,
  type ShoalStorage,
  type UndecryptableOp,
} from "../src/engine.js";
import { ShoalError } from "../src/errors.js";
import { Hlc } from "../src/hlc.js";
import { b64url } from "../src/keys.js";

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

function make(
  fetchImpl: typeof fetch,
  extra: Partial<ShoalConfig> = {},
  storage = new MemoryStorage(),
) {
  const sync = new ShoalSync({
    serverUrl: "http://fake",
    mnemonic: PHRASE,
    collection: "test",
    nodeId: 1,
    storage,
    apply: async () => {},
    fetchImpl,
    ...extra,
  });
  return { sync, storage };
}

function emptyPull() {
  return new Response(JSON.stringify({ ops: [], head: 0 }), { status: 200 });
}

describe("record size validation", () => {
  it("refuses a record too large for the server before it enters the outbox", async () => {
    // An op the server will always reject must never be queued: the outbox
    // drains in order, so one undeliverable op blocks everything behind it.
    const { sync, storage } = make((async () => emptyPull()) as unknown as typeof fetch);
    const huge = { blob: "x".repeat(DEFAULT_MAX_PAYLOAD_BYTES) };

    await expect(sync.record("r/big", huge)).rejects.toThrow(RangeError);
    expect(storage.outbox).toHaveLength(0);
  });

  it("accepts a record that fits", async () => {
    const { sync, storage } = make((async () => emptyPull()) as unknown as typeof fetch);
    await sync.record("r/ok", { blob: "x".repeat(1000) });
    expect(storage.outbox).toHaveLength(1);
  });

  it("honours a lower configured ceiling", async () => {
    const { sync } = make((async () => emptyPull()) as unknown as typeof fetch, {
      maxPayloadBytes: 100,
    });
    await expect(sync.record("r/x", { blob: "y".repeat(200) })).rejects.toThrow(/over the 100 byte/);
  });
});

describe("push batching", () => {
  it("splits a batch that would exceed the byte budget", async () => {
    const batches: number[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method === "POST") {
        batches.push(JSON.parse(init.body).ops.length);
        return new Response(JSON.stringify({ results: [], head: 0 }), { status: 200 });
      }
      return emptyPull();
    }) as unknown as typeof fetch;

    // Budget fits roughly two ops, so twenty queued ops must go in several
    // requests rather than one oversized body.
    const { sync, storage } = make(fetchImpl, { maxBatchBytes: 4_000 });
    for (let i = 0; i < 20; i++) await sync.record(`r/${i}`, { pad: "z".repeat(1000) });
    expect(storage.outbox).toHaveLength(20);

    await sync.sync();

    expect(storage.outbox).toHaveLength(0);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThan(20);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("always sends at least one op even if it alone exceeds the budget", async () => {
    const batches: number[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method === "POST") {
        batches.push(JSON.parse(init.body).ops.length);
        return new Response(JSON.stringify({ results: [], head: 0 }), { status: 200 });
      }
      return emptyPull();
    }) as unknown as typeof fetch;

    const { sync, storage } = make(fetchImpl, { maxBatchBytes: 10 });
    await sync.record("r/1", { pad: "z".repeat(500) });
    await sync.sync();

    expect(batches).toEqual([1]);
    expect(storage.outbox).toHaveLength(0);
  });

  it("halves the batch and retries when the server answers 413", async () => {
    const attempts: number[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method === "POST") {
        const count = JSON.parse(init.body).ops.length;
        attempts.push(count);
        if (count > 2) return new Response("too large", { status: 413 });
        return new Response(JSON.stringify({ results: [], head: 0 }), { status: 200 });
      }
      return emptyPull();
    }) as unknown as typeof fetch;

    const { sync, storage } = make(fetchImpl);
    for (let i = 0; i < 8; i++) await sync.record(`r/${i}`, { i });

    await sync.sync();

    expect(attempts[0]).toBe(8);
    expect(attempts.some((n) => n <= 2)).toBe(true);
    expect(storage.outbox).toHaveLength(0);
  });

  it("surfaces a terminal status instead of retrying it forever", async () => {
    let calls = 0;
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method === "POST") {
        calls++;
        return new Response("server full", { status: 507 });
      }
      return emptyPull();
    }) as unknown as typeof fetch;

    const { sync, storage } = make(fetchImpl);
    await sync.record("r/1", { a: 1 });

    await expect(sync.sync()).rejects.toThrow(ShoalError);
    expect(calls).toBe(1);
    // The op stays queued: it was never accepted.
    expect(storage.outbox).toHaveLength(1);
  });

  it("carries Retry-After through to the error", async () => {
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method === "POST") {
        return new Response("slow down", { status: 429, headers: { "Retry-After": "12" } });
      }
      return emptyPull();
    }) as unknown as typeof fetch;

    const { sync } = make(fetchImpl);
    await sync.record("r/1", { a: 1 });

    await sync.sync().then(
      () => expect.fail("should have thrown"),
      (err: ShoalError) => {
        expect(err.rateLimited).toBe(true);
        expect(err.retryAfterMs).toBe(12_000);
        expect(err.terminal).toBe(false);
      },
    );
  });
});

describe("unreadable ops", () => {
  function serverWith(ops: any[]) {
    return (async (url: any, init: any) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ results: [], head: ops.length }), { status: 200 });
      }
      const since = Number(new URL(String(url)).searchParams.get("since") ?? 0);
      return new Response(
        JSON.stringify({ ops: ops.filter((o) => o.seq > since), head: ops.length }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  it("reports a payload encrypted under a different key as a decrypt failure", async () => {
    const seen: UndecryptableOp[] = [];
    const fetchImpl = serverWith([
      {
        op_id: "bad",
        collection: "test",
        record_id: "r/1",
        hlc: Hlc.encode(1000, 0, 1),
        payload: b64url(new Uint8Array(64)),
        seq: 1,
      },
    ]);

    const { sync } = make(fetchImpl, { onUndecryptable: (info) => seen.push(info) });
    await sync.sync();

    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("decrypt");
    expect(seen[0].recordId).toBe("r/1");
  });

  it("distinguishes a payload that decrypts but is not JSON", async () => {
    // Encrypted with the right key, so it decrypts cleanly, but the plaintext
    // is not JSON. Conflating this with a key mismatch hides real bugs.
    const { SyncKeys } = await import("../src/keys.js");
    const keys = SyncKeys.fromMnemonic(PHRASE);
    const payload = b64url(
      keys.encrypt(new TextEncoder().encode("{not json"), "test", "r/2"),
    );

    const seen: UndecryptableOp[] = [];
    const fetchImpl = serverWith([
      {
        op_id: "nonjson",
        collection: "test",
        record_id: "r/2",
        hlc: Hlc.encode(2000, 0, 1),
        payload,
        seq: 1,
      },
    ]);

    const { sync } = make(fetchImpl, { onUndecryptable: (info) => seen.push(info) });
    await sync.sync();

    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("parse");
  });

  it("advances the cursor past an unreadable op so sync keeps moving", async () => {
    const fetchImpl = serverWith([
      {
        op_id: "bad",
        collection: "test",
        record_id: "r/1",
        hlc: Hlc.encode(1000, 0, 1),
        payload: b64url(new Uint8Array(64)),
        seq: 1,
      },
    ]);
    const { sync, storage } = make(fetchImpl);
    await sync.sync();
    expect(storage.cursor).toBe(1);
  });
});

describe("sync coalescing", () => {
  it("joins concurrent callers onto one round", async () => {
    let pulls = 0;
    const fetchImpl = (async (url: any, init: any) => {
      if (init?.method !== "POST") {
        pulls++;
        await new Promise((r) => setTimeout(r, 10));
        return emptyPull();
      }
      return new Response(JSON.stringify({ results: [], head: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { sync } = make(fetchImpl);
    await Promise.all([sync.sync(), sync.sync(), sync.sync()]);

    // Three callers, but the extra two only schedule one follow-up round
    // rather than three independent ones.
    expect(pulls).toBeLessThanOrEqual(2);
  });
});
