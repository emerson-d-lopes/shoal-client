import { Hlc } from "./hlc.js";
import { SyncKeys, b64url, b64urlDecode } from "./keys.js";
/**
 * Push the outbox, pull past the cursor, merge — one class per synced app.
 * Every network failure throws; callers treat sync as opportunistic and the
 * app never depends on it.
 */
export class ShoalSync {
    cfg;
    keys;
    hlc;
    fetchImpl;
    constructor(cfg) {
        this.cfg = cfg;
        this.keys = SyncKeys.fromMnemonic(cfg.mnemonic);
        this.hlc = new Hlc(cfg.nodeId);
        this.fetchImpl = cfg.fetchImpl ?? fetch;
    }
    get publicKeyB64() {
        return this.keys.publicKeyB64;
    }
    /** Record a local write: full record state, or null for a tombstone marker. */
    async record(recordId, body) {
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
    async sync() {
        await this.pushAll();
        await this.pullAll();
    }
    async pushAll() {
        for (;;) {
            const batch = await this.cfg.storage.outboxBatch(500);
            if (batch.length === 0)
                return;
            const ops = batch.map((row) => ({
                op_id: row.opId,
                collection: this.cfg.collection,
                record_id: row.recordId,
                hlc: row.hlc,
                payload: b64url(this.keys.encrypt(new TextEncoder().encode(row.payload), this.cfg.collection, row.recordId)),
            }));
            await this.call("POST", "/v1/ops", JSON.stringify({ ops }));
            await this.cfg.storage.clearOutbox(batch.map((r) => r.opId));
        }
    }
    async pullAll() {
        for (;;) {
            const since = await this.cfg.storage.getCursor();
            const resp = (await this.call("GET", `/v1/ops?since=${since}&collection=${encodeURIComponent(this.cfg.collection)}&limit=500`));
            if (resp.ops.length === 0)
                return;
            for (const op of resp.ops) {
                await this.apply(op);
            }
            const newCursor = Math.max(...resp.ops.map((o) => o.seq ?? since));
            await this.cfg.storage.setCursor(newCursor);
            if (newCursor >= resp.head)
                return;
        }
    }
    async apply(op) {
        const current = await this.cfg.storage.getHlc(op.record_id);
        // Equal stamp = our own echoed op; also skipped.
        if (!Hlc.isNewer(op.hlc, current))
            return;
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(this.keys.decrypt(b64urlDecode(op.payload), op.collection, op.record_id)));
        }
        catch {
            // Wrong key or corrupt op: record the hlc so sync cannot wedge on it.
            await this.cfg.storage.putHlc(op.record_id, op.hlc);
            return;
        }
        await this.cfg.apply(op.record_id, body, op.hlc);
        await this.cfg.storage.putHlc(op.record_id, op.hlc);
        this.hlc.observe(op.hlc);
    }
    async call(method, pathAndQuery, body) {
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
