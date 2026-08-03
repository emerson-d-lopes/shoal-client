import { Hlc } from "./hlc.js";
import { SyncKeys, b64url, b64urlDecode } from "./keys.js";
import { ShoalError, ShoalNetworkError, parseRetryAfter } from "./errors.js";

export interface OutboxOp {
  opId: string;
  recordId: string;
  hlc: string;
  /** Plaintext JSON string; encrypted at push time. */
  payload: string;
  createdAt: number;
  /** Which collection the op belongs to. Absent on rows written before v0.2. */
  collection?: string;
}

/**
 * Storage the host app provides (the Dexie adapter implements this over three
 * extra tables in the app's own database). Outbox writes must happen in the
 * same transaction as the data change they describe.
 *
 * Every method is scoped to one collection. An implementation shared between
 * two collections must namespace its keys, or the two will overwrite each
 * other's cursor and record metadata.
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

/** What the server removed in response to a compaction request. */
export interface CompactResult {
  /** Ops dropped by this call. */
  removed: number;
  /** Ops still stored for this user, across every collection. */
  remaining: number;
  /** Unchanged by compaction. */
  head: number;
}

/** Why an incoming op could not be turned back into a record. */
export interface UndecryptableOp {
  recordId: string;
  collection: string;
  hlc: string;
  reason: "decrypt" | "parse";
  error: unknown;
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
  /**
   * Called when an op arrives that this client cannot read. The op is skipped
   * and its hlc recorded either way, so sync does not stall on it, but the
   * record silently stops tracking that write. Wrong mnemonic is the usual
   * cause; a client version mismatch is the other.
   */
  onUndecryptable?: (info: UndecryptableOp) => void;
  /** Called for every error the live-sync loop absorbs. */
  onError?: (error: unknown) => void;
  /** Per-op ciphertext ceiling. Must not exceed the server's. */
  maxPayloadBytes?: number;
  /** Serialized bytes per push. Must stay under the server's body limit. */
  maxBatchBytes?: number;
  /** Ops per push, before the byte budget trims it further. */
  maxBatchOps?: number;
  /** Backoff floor and ceiling for the live-sync loop. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How often `start()` compacts, in milliseconds. Off by default.
   *
   * Only set this if the collection merges last-writer-wins, which is what
   * `apply` does when it overwrites a record. A collection whose history is
   * meaningful, appended and never superseded, loses data to compaction.
   */
  autoCompactEveryMs?: number;
}

interface WireOp {
  op_id: string;
  collection: string;
  record_id: string;
  hlc: string;
  payload: string;
  seq?: number;
}

/** Matches the server's own per-op ceiling, measured on decoded bytes. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
/**
 * Kept under the server's 16 MiB body limit with room for JSON overhead, so
 * a large batch is trimmed here rather than bounced with a 413.
 */
export const DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_BATCH_OPS = 500;

/** XChaCha20-Poly1305 adds a 24-byte nonce and a 16-byte tag. */
const CIPHERTEXT_OVERHEAD = 40;

const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * Push the outbox, pull past the cursor, merge — one instance per synced
 * collection. Every network failure throws; callers treat sync as
 * opportunistic and the app never depends on it.
 *
 * `sync()` runs one round on demand. `start()` runs rounds continuously,
 * driven by the server's poke stream, until `stop()`.
 */
export class ShoalSync {
  private readonly keys: SyncKeys;
  private readonly hlc: Hlc;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPayloadBytes: number;
  private readonly maxBatchBytes: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  /** Trimmed when the server rejects a batch as too large, restored on success. */
  private batchOps: number;
  private readonly configuredBatchOps: number;

  private running = false;
  private inFlight?: Promise<void>;
  private again = false;
  private abort?: AbortController;
  private wake?: () => void;
  private listenersAttached = false;
  /** Zero means "never", so the first live round compacts if it is enabled. */
  private lastCompactAt = 0;

  constructor(private readonly cfg: ShoalConfig) {
    this.keys = SyncKeys.fromMnemonic(cfg.mnemonic);
    this.hlc = new Hlc(cfg.nodeId);
    // Bound so the call in `call()` does not pass `this` as the receiver:
    // browsers throw "Illegal invocation" when window.fetch is called with
    // anything other than the window. Node's fetch does not care, which is
    // why only browser runs ever hit it.
    this.fetchImpl = cfg.fetchImpl ?? fetch.bind(globalThis);
    this.maxPayloadBytes = cfg.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxBatchBytes = cfg.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.minBackoffMs = cfg.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = cfg.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.configuredBatchOps = cfg.maxBatchOps ?? DEFAULT_MAX_BATCH_OPS;
    this.batchOps = this.configuredBatchOps;
    this.onOnline = this.onOnline.bind(this);
    this.onVisible = this.onVisible.bind(this);
  }

  get publicKeyB64(): string {
    return this.keys.publicKeyB64;
  }

  /** Whether the live-sync loop is running. */
  get live(): boolean {
    return this.running;
  }

  /**
   * Record a local write: full record state, or null for a tombstone marker.
   *
   * Oversized records are refused here rather than at push time. An op that
   * the server will always reject cannot be allowed into the outbox, because
   * the outbox drains in order and one undeliverable op blocks everything
   * queued behind it.
   */
  async record(recordId: string, body: unknown): Promise<void> {
    const payload = JSON.stringify(body);
    const size = new TextEncoder().encode(payload).length + CIPHERTEXT_OVERHEAD;
    if (size > this.maxPayloadBytes) {
      throw new RangeError(
        `shoal: record ${recordId} encrypts to ${size} bytes, over the ${this.maxPayloadBytes} byte limit`,
      );
    }
    const stamp = this.hlc.next();
    await this.cfg.storage.enqueue({
      opId: crypto.randomUUID(),
      recordId,
      hlc: stamp,
      payload,
      createdAt: Date.now(),
      collection: this.cfg.collection,
    });
    await this.cfg.storage.putHlc(recordId, stamp);
    // In live mode the loop is parked on the poke stream, which only signals
    // ops arriving FROM the server, so nothing would push this write until
    // the next reconnect or tab refocus. Start a round now; bursts coalesce
    // through sync()'s in-flight join, and failures go where the loop's go.
    if (this.running) {
      void this.sync().catch((error) => this.cfg.onError?.(error));
    }
  }

  /**
   * Ask the server to drop ops that later writes superseded.
   *
   * Compaction runs only up to this client's pull cursor, so it never removes
   * anything this client has not already seen and merged. Each record keeps
   * its newest op, which under last-writer-wins is the only one that could
   * ever be applied, so a device that never synced still converges to the
   * same state. It just skips intermediate values, which LWW discards anyway.
   *
   * Do not call this for a collection whose ops are merged append-only. Every
   * op there carries meaning that the newest one does not subsume.
   *
   * Push first, so nothing still queued locally is left as the only copy of a
   * record whose server-side history just shrank.
   */
  async compact(): Promise<CompactResult> {
    await this.pushAll();
    const through = await this.cfg.storage.getCursor();
    if (through <= 0) return { removed: 0, remaining: 0, head: 0 };
    return (await this.call(
      "POST",
      "/v1/compact",
      JSON.stringify({ collection: this.cfg.collection, through }),
    )) as CompactResult;
  }

  /**
   * One full round: drain outbox, then pull and apply everything new.
   *
   * Concurrent callers join the round already in flight. A call that arrives
   * mid-round schedules one more round after it, so a poke that lands while
   * syncing is never lost.
   */
  sync(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          await this.pushAll();
          await this.pullAll();
        } while (this.again);
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /**
   * Start live sync: an initial round, then a round on every server poke,
   * reconnecting with exponential backoff. Resolves once the loop is running;
   * it keeps running in the background until `stop()`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachListeners();
    void this.loop();
  }

  /** Stop live sync and abort any open poke stream. */
  stop(): void {
    this.running = false;
    this.detachListeners();
    this.abort?.abort();
    this.abort = undefined;
    this.wake?.();
  }

  private async loop(): Promise<void> {
    let backoff = 0;
    while (this.running) {
      try {
        await this.sync();
        this.batchOps = this.configuredBatchOps;
        await this.maybeCompact();
        // Resolves when the stream closes, which is the cue to reconnect.
        const openedAt = Date.now();
        await this.listenForPokes();
        if (!this.running) return;
        // A stream that stayed up is evidence the server is healthy, so the
        // next reconnect starts from the floor again. One that dies instantly
        // keeps escalating, which also stops this loop from spinning against
        // a server that accepts and immediately closes.
        backoff = Date.now() - openedAt >= this.minBackoffMs ? 0 : this.nextBackoff(backoff);
        await this.pause(Math.max(backoff, this.minBackoffMs));
      } catch (error) {
        if (!this.running) return;
        this.cfg.onError?.(error);
        if (error instanceof ShoalError && error.terminal) {
          // 403 and 507 do not resolve themselves. Stopping is honest; the
          // app can restart the loop once the operator has acted.
          this.running = false;
          this.detachListeners();
          return;
        }
        const hint = error instanceof ShoalError ? error.retryAfterMs : undefined;
        backoff = hint ?? this.nextBackoff(backoff);
        await this.pause(backoff);
      }
    }
  }

  /**
   * Compacts on the configured interval while the live loop runs. A failure
   * here is reported but not rethrown: compaction is housekeeping, and losing
   * the poke stream over it would be a worse outcome than a larger log.
   */
  private async maybeCompact(): Promise<void> {
    const every = this.cfg.autoCompactEveryMs;
    if (!every || every <= 0) return;
    const now = Date.now();
    if (now - this.lastCompactAt < every) return;
    this.lastCompactAt = now;
    try {
      await this.compact();
    } catch (error) {
      this.cfg.onError?.(error);
    }
  }

  /** Exponential with full jitter, so reconnecting clients do not synchronize. */
  private nextBackoff(previous: number): number {
    const target = previous === 0 ? this.minBackoffMs : Math.min(previous * 2, this.maxBackoffMs);
    return this.minBackoffMs + Math.random() * (target - this.minBackoffMs);
  }

  /** Sleeps, but returns early if `stop()` is called. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Reads the server's SSE stream and syncs on each poke.
   *
   * EventSource cannot set request headers, and every shoal request needs a
   * signature in one, so the stream is read from `fetch` and framed by hand.
   */
  private async listenForPokes(): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const response = await this.request("GET", "/v1/poke", undefined, controller.signal);
    const body = response.body;
    if (!body) return; // No streaming support; the caller falls back to backoff.

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !this.running) return;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          // Keep-alive comments start with ':' and carry no event.
          if (/^event:\s*poke$/m.test(frame)) await this.sync();
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  private attachListeners(): void {
    if (this.listenersAttached || typeof window === "undefined") return;
    window.addEventListener("online", this.onOnline);
    document?.addEventListener?.("visibilitychange", this.onVisible);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached || typeof window === "undefined") return;
    window.removeEventListener("online", this.onOnline);
    document?.removeEventListener?.("visibilitychange", this.onVisible);
    this.listenersAttached = false;
  }

  /** Connectivity is back: stop waiting out the backoff and retry now. */
  private onOnline(): void {
    this.wake?.();
  }

  private onVisible(): void {
    if (document?.visibilityState === "visible") this.wake?.();
  }

  /**
   * Encrypts and frames as many queued ops as fit in one request.
   *
   * The byte budget matters because the op count alone does not bound the
   * request size: 500 ops at the per-op ceiling is many times the server's
   * body limit. At least one op is always included, so a full outbox always
   * makes progress.
   */
  private packBatch(rows: OutboxOp[]): { ops: WireOp[]; taken: OutboxOp[] } {
    const ops: WireOp[] = [];
    const taken: OutboxOp[] = [];
    let bytes = 0;
    for (const row of rows) {
      const wire: WireOp = {
        op_id: row.opId,
        collection: this.cfg.collection,
        record_id: row.recordId,
        hlc: row.hlc,
        payload: b64url(
          this.keys.encrypt(
            new TextEncoder().encode(row.payload),
            this.cfg.collection,
            row.recordId,
          ),
        ),
      };
      const size = JSON.stringify(wire).length + 1;
      if (ops.length > 0 && bytes + size > this.maxBatchBytes) break;
      bytes += size;
      ops.push(wire);
      taken.push(row);
    }
    return { ops, taken };
  }

  private async pushAll(): Promise<void> {
    for (;;) {
      const rows = await this.cfg.storage.outboxBatch(this.batchOps);
      if (rows.length === 0) return;
      const { ops, taken } = this.packBatch(rows);

      try {
        await this.call("POST", "/v1/ops", JSON.stringify({ ops }));
      } catch (error) {
        // The server draws the line somewhere below our budget. Halve and
        // retry rather than stalling the outbox forever.
        if (error instanceof ShoalError && error.tooLarge && ops.length > 1) {
          this.batchOps = Math.max(1, Math.floor(ops.length / 2));
          continue;
        }
        throw error;
      }
      await this.cfg.storage.clearOutbox(taken.map((r) => r.opId));
    }
  }

  private async pullAll(): Promise<void> {
    for (;;) {
      const since = await this.cfg.storage.getCursor();
      const resp = (await this.call(
        "GET",
        `/v1/ops?since=${since}&collection=${encodeURIComponent(this.cfg.collection)}&limit=500`,
      )) as { ops: WireOp[]; head: number };
      if (resp.ops.length === 0) return;
      for (const op of resp.ops) {
        await this.apply(op);
      }
      const newCursor = Math.max(...resp.ops.map((o) => o.seq ?? since));
      // A server that returns ops at or below the cursor would otherwise spin
      // this loop forever.
      if (newCursor <= since) return;
      await this.cfg.storage.setCursor(newCursor);
      if (newCursor >= resp.head) return;
    }
  }

  private async apply(op: WireOp): Promise<void> {
    // Fold every remote stamp in, including ones the gate below rejects, so
    // the local clock stays ahead of anything already written elsewhere.
    this.hlc.observe(op.hlc);

    const current = await this.cfg.storage.getHlc(op.record_id);
    // Equal stamp = our own echoed op; also skipped.
    if (!Hlc.isNewer(op.hlc, current)) return;

    let plaintext: Uint8Array;
    try {
      plaintext = this.keys.decrypt(b64urlDecode(op.payload), op.collection, op.record_id);
    } catch (error) {
      await this.skipUnreadable(op, "decrypt", error);
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      await this.skipUnreadable(op, "parse", error);
      return;
    }

    await this.cfg.apply(op.record_id, body, op.hlc);
    await this.cfg.storage.putHlc(op.record_id, op.hlc);
  }

  /**
   * Records the hlc of an op this client cannot read, so sync does not wedge
   * on it, and tells the app it happened. Advancing the stamp means later
   * writes to that record still apply, at the cost of losing this one.
   */
  private async skipUnreadable(
    op: WireOp,
    reason: "decrypt" | "parse",
    error: unknown,
  ): Promise<void> {
    await this.cfg.storage.putHlc(op.record_id, op.hlc);
    this.cfg.onUndecryptable?.({
      recordId: op.record_id,
      collection: op.collection,
      hlc: op.hlc,
      reason,
      error,
    });
  }

  private async request(
    method: string,
    pathAndQuery: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ts = Math.floor(Date.now() / 1000);
    const bodyBytes = new TextEncoder().encode(body ?? "");
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.serverUrl.replace(/\/$/, "") + pathAndQuery, {
        method,
        body: method === "GET" ? undefined : body,
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Shoal-Pubkey": this.keys.publicKeyB64,
          "X-Shoal-Timestamp": String(ts),
          "X-Shoal-Signature": this.keys.requestSignature(method, pathAndQuery, ts, bodyBytes),
        },
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ShoalNetworkError(method, pathAndQuery, cause);
    }
    if (!response.ok) {
      throw new ShoalError(
        response.status,
        method,
        pathAndQuery,
        await response.text().catch(() => ""),
        parseRetryAfter(response.headers.get("Retry-After"), Date.now()),
      );
    }
    return response;
  }

  private async call(method: string, pathAndQuery: string, body?: string): Promise<unknown> {
    const response = await this.request(method, pathAndQuery, body);
    return response.json();
  }
}
