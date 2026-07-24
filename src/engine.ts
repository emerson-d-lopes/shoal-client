import { Hlc } from "./hlc.js";
import { SyncKeys, b64url, b64urlDecode } from "./keys.js";

export interface OutboxOp {
  opId: string;
  recordId: string;
  hlc: string;
  /** Plaintext JSON string; encrypted at push time. */
  payload: string;
  createdAt: number;
}

/**
 * Storage the host app provides (the Dexie adapter implements this over two
 * extra tables in the app's own database). Outbox writes must happen in the
 * same transaction as the data change they describe.
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
}

interface WireOp {
  op_id: string;
  collection: string;
  record_id: string;
  hlc: string;
  payload: string;
  seq?: number;
}

/**
 * Push the outbox, pull past the cursor, merge — one class per synced app.
 * Every network failure throws; callers treat sync as opportunistic and the
 * app never depends on it.
 */
export class ShoalSync {
  private readonly keys: SyncKeys;
  private readonly hlc: Hlc;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ShoalConfig) {
    this.keys = SyncKeys.fromMnemonic(cfg.mnemonic);
    this.hlc = new Hlc(cfg.nodeId);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get publicKeyB64(): string {
    return this.keys.publicKeyB64;
  }

  /** Record a local write: full record state, or null for a tombstone marker. */
  async record(recordId: string, body: unknown): Promise<void> {
    const stamp = this.hlc.next();
    await this.cfg.storage.enqueue({
      opId: crypto.randomUUID(),
      recordId,
      hlc: stamp,
      payload: JSON.stringify(body),
      createdAt: Date.now(),
    });
    await this.cfg.storage.putHlc(recordId, stamp);
  }

  /** One full round: drain outbox, then pull and apply everything new. */
  async sync(): Promise<void> {
    await this.pushAll();
    await this.pullAll();
  }

  private async pushAll(): Promise<void> {
    for (;;) {
      const batch = await this.cfg.storage.outboxBatch(500);
      if (batch.length === 0) return;
      const ops: WireOp[] = batch.map((row) => ({
        op_id: row.opId,
        collection: this.cfg.collection,
        record_id: row.recordId,
        hlc: row.hlc,
        payload: b64url(
          this.keys.encrypt(new TextEncoder().encode(row.payload), this.cfg.collection, row.recordId),
        ),
      }));
      await this.call("POST", "/v1/ops", JSON.stringify({ ops }));
      await this.cfg.storage.clearOutbox(batch.map((r) => r.opId));
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
      await this.cfg.storage.setCursor(newCursor);
      if (newCursor >= resp.head) return;
    }
  }

  private async apply(op: WireOp): Promise<void> {
    const current = await this.cfg.storage.getHlc(op.record_id);
    // Equal stamp = our own echoed op; also skipped.
    if (!Hlc.isNewer(op.hlc, current)) return;
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder().decode(this.keys.decrypt(b64urlDecode(op.payload), op.collection, op.record_id)),
      );
    } catch {
      // Wrong key or corrupt op: record the hlc so sync cannot wedge on it.
      await this.cfg.storage.putHlc(op.record_id, op.hlc);
      return;
    }
    await this.cfg.apply(op.record_id, body, op.hlc);
    await this.cfg.storage.putHlc(op.record_id, op.hlc);
    this.hlc.observe(op.hlc);
  }

  private async call(method: string, pathAndQuery: string, body?: string): Promise<unknown> {
    const ts = Math.floor(Date.now() / 1000);
    const bodyBytes = new TextEncoder().encode(body ?? "");
    const resp = await this.fetchImpl(this.cfg.serverUrl.replace(/\/$/, "") + pathAndQuery, {
      method,
      body: method === "GET" ? undefined : body,
      headers: {
        "Content-Type": "application/json",
        "X-Shoal-Pubkey": this.keys.publicKeyB64,
        "X-Shoal-Timestamp": String(ts),
        "X-Shoal-Signature": this.keys.requestSignature(method, pathAndQuery, ts, bodyBytes),
      },
    });
    if (!resp.ok) {
      throw new Error(`shoal ${resp.status} on ${method} ${pathAndQuery}: ${(await resp.text()).slice(0, 200)}`);
    }
    return resp.json();
  }
}
