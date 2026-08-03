import { describe, expect, it } from "vitest";
import { ShoalSync, type OutboxOp, type ShoalStorage } from "../src/engine.js";
import { Hlc } from "../src/hlc.js";
import { SyncKeys, b64url } from "../src/keys.js";

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

/**
 * A shoal server with a controllable SSE stream, so tests can decide exactly
 * when a poke lands.
 */
function pokeServer() {
  const keys = SyncKeys.fromMnemonic(PHRASE);
  const log: any[] = [];
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let connections = 0;
  let pokeStatus = 200;

  const fetchImpl = (async (url: any, init: any) => {
    const u = new URL(String(url));

    if (u.pathname === "/v1/poke") {
      if (pokeStatus !== 200) return new Response("nope", { status: pokeStatus });
      connections++;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          controller = undefined;
        },
      });
      init?.signal?.addEventListener("abort", () => {
        try {
          controller?.close();
        } catch {
          /* already closed */
        }
        controller = undefined;
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    if (init?.method === "POST") {
      for (const op of JSON.parse(init.body).ops) {
        if (!log.some((o) => o.op_id === op.op_id)) log.push({ ...op, seq: log.length + 1 });
      }
      return new Response(JSON.stringify({ results: [], head: log.length }), { status: 200 });
    }

    const since = Number(u.searchParams.get("since") ?? 0);
    return new Response(
      JSON.stringify({ ops: log.filter((o) => o.seq > since), head: log.length }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  return {
    log,
    fetchImpl,
    get connections() {
      return connections;
    },
    get connected() {
      return controller !== undefined;
    },
    setPokeStatus(status: number) {
      pokeStatus = status;
    },
    /** Adds a record to the server log as if another device had pushed it. */
    seed(recordId: string, body: unknown, ms: number) {
      log.push({
        op_id: `seed-${log.length}`,
        collection: "test",
        record_id: recordId,
        hlc: Hlc.encode(ms, 0, 99),
        payload: b64url(
          keys.encrypt(new TextEncoder().encode(JSON.stringify(body)), "test", recordId),
        ),
        seq: log.length + 1,
      });
    },
    poke(head: number) {
      controller?.enqueue(encoder.encode(`event: poke\ndata: {"head":${head}}\n\n`));
    },
    comment() {
      controller?.enqueue(encoder.encode(`: keep-alive\n\n`));
    },
    endStream() {
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
      controller = undefined;
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeLive(server: ReturnType<typeof pokeServer>, applied: Record<string, unknown>, extra = {}) {
  return new ShoalSync({
    serverUrl: "http://fake",
    mnemonic: PHRASE,
    collection: "test",
    nodeId: 1,
    storage: new MemoryStorage(),
    apply: async (recordId, body) => {
      applied[recordId] = body;
    },
    fetchImpl: server.fetchImpl,
    minBackoffMs: 10,
    maxBackoffMs: 50,
    ...extra,
  });
}

describe("live sync", () => {
  it("syncs once on start and opens a poke stream", async () => {
    const server = pokeServer();
    server.seed("habit/h1", { name: "run" }, 1000);
    const applied: Record<string, unknown> = {};
    const sync = makeLive(server, applied);

    sync.start();
    try {
      await waitFor(() => applied["habit/h1"] !== undefined, "initial sync");
      await waitFor(() => server.connected, "poke stream");
      expect(sync.live).toBe(true);
    } finally {
      sync.stop();
    }
  });

  it("pulls again when the server pokes", async () => {
    const server = pokeServer();
    const applied: Record<string, unknown> = {};
    const sync = makeLive(server, applied);

    sync.start();
    try {
      await waitFor(() => server.connected, "poke stream");
      expect(applied["habit/h2"]).toBeUndefined();

      // Another device writes, then the server nudges us.
      server.seed("habit/h2", { name: "stretch" }, 2000);
      server.poke(1);

      await waitFor(() => applied["habit/h2"] !== undefined, "sync after poke");
      expect(applied["habit/h2"]).toEqual({ name: "stretch" });
    } finally {
      sync.stop();
    }
  });

  it("ignores keep-alive comments", async () => {
    const server = pokeServer();
    const applied: Record<string, unknown> = {};
    const sync = makeLive(server, applied);

    sync.start();
    try {
      await waitFor(() => server.connected, "poke stream");
      server.seed("habit/h3", { name: "ignored" }, 3000);
      server.comment();
      await new Promise((r) => setTimeout(r, 100));
      // A comment frame is not a poke, so nothing should have been pulled.
      expect(applied["habit/h3"]).toBeUndefined();

      server.poke(1);
      await waitFor(() => applied["habit/h3"] !== undefined, "sync after real poke");
    } finally {
      sync.stop();
    }
  });

  it("pushes a local record() while parked on the poke stream", async () => {
    // The stream only signals server-side arrivals, so without record()
    // scheduling its own round a live client's writes would sit in the outbox
    // until the next reconnect or refocus.
    const server = pokeServer();
    const sync = makeLive(server, {});

    sync.start();
    try {
      await waitFor(() => server.connected, "poke stream");
      expect(server.log).toHaveLength(0);

      await sync.record("habit/local", { name: "written while live" });
      await waitFor(() => server.log.length === 1, "push without manual sync()");
    } finally {
      sync.stop();
    }
  });

  it("reconnects after the stream ends", async () => {
    const server = pokeServer();
    const sync = makeLive(server, {});

    sync.start();
    try {
      await waitFor(() => server.connections >= 1, "first connection");
      server.endStream();
      await waitFor(() => server.connections >= 2, "reconnect");
    } finally {
      sync.stop();
    }
  });

  it("stops on a terminal status instead of reconnecting forever", async () => {
    const server = pokeServer();
    server.setPokeStatus(403);
    const errors: unknown[] = [];
    const sync = makeLive(server, {}, { onError: (e: unknown) => errors.push(e) });

    sync.start();
    await waitFor(() => sync.live === false, "loop to give up");
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("403");
  });

  it("keeps retrying a transient status", async () => {
    const server = pokeServer();
    server.setPokeStatus(503);
    const errors: unknown[] = [];
    const sync = makeLive(server, {}, { onError: (e: unknown) => errors.push(e) });

    sync.start();
    try {
      await waitFor(() => errors.length >= 3, "repeated retries");
      expect(sync.live).toBe(true);
    } finally {
      sync.stop();
    }
  });

  it("stop() is idempotent and halts reconnects", async () => {
    const server = pokeServer();
    const sync = makeLive(server, {});
    sync.start();
    await waitFor(() => server.connected, "poke stream");

    sync.stop();
    sync.stop();
    expect(sync.live).toBe(false);

    const seen = server.connections;
    await new Promise((r) => setTimeout(r, 150));
    expect(server.connections).toBe(seen);
  });

  it("start() twice does not open two streams", async () => {
    const server = pokeServer();
    const sync = makeLive(server, {});
    sync.start();
    sync.start();
    try {
      await waitFor(() => server.connections >= 1, "connection");
      await new Promise((r) => setTimeout(r, 100));
      expect(server.connections).toBe(1);
    } finally {
      sync.stop();
    }
  });
});
