# shoal-client

TypeScript client for [shoal](https://github.com/emerson-d-lopes/shoal),
the self-hosted end-to-end-encrypted sync server for local-first apps.
Wire-compatible with the Kotlin client and the Rust server: the test
suite pins the exact identity derivation all clients share.

Crypto is [noble/scure](https://paulmillr.com/noble/): BIP39 phrase to an
ed25519 request-signing key and an XChaCha20-Poly1305 payload key. The
server only ever sees ciphertext.

## Install

```sh
pnpm add github:emerson-d-lopes/shoal-client
```

## Use

```ts
import { ShoalSync, SyncKeys } from "shoal-client";
import { DexieShoalStorage } from "shoal-client/dexie";

// In your Dexie schema's next version:
//   _shoal_outbox: "opId, createdAt",
//   _shoal_meta: "recordId",
//   _shoal_kv: "key",

const sync = new ShoalSync({
  serverUrl: "https://your-shoal.example",
  mnemonic: SyncKeys.generateMnemonic(), // show it to the user once
  collection: "myapp",
  nodeId: crypto.getRandomValues(new Uint32Array(1))[0], // persist this
  storage: new DexieShoalStorage(db),
  apply: async (recordId, body) => {
    // Route on recordId prefix and write to your tables. Called only when
    // the incoming op wins LWW; never called for your own echoed ops.
  },
});

// After every local write: full record state, keyed by a stable record id.
await sync.record(`habit/${habit.id}`, habit);

// Whenever online (interval, visibilitychange, a Sync button):
await sync.sync(); // push outbox, pull + merge

// Restore on a new device = same mnemonic + sync().
```

The outbox lives in your app's own database, so writes never wait on the
network and a dead server costs nothing. `sync()` throws on failure; call it
opportunistically and retry later.

## License

MIT
