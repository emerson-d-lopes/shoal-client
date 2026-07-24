import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
/**
 * Key material derived from the 12-word recovery phrase, per shoal
 * PROTOCOL.md:
 *
 *   seed     = BIP39-seed(mnemonic, empty passphrase)      64 bytes
 *   sign_key = HKDF-SHA256(seed, info="shoal/v1/sign")     ed25519 seed
 *   enc_key  = HKDF-SHA256(seed, info="shoal/v1/enc")      XChaCha20-Poly1305
 *
 * Wire-compatible with the Kotlin (Tink) and Python reference clients.
 */
export class SyncKeys {
    signSeed;
    encKey;
    /** base64url(ed25519 public key) — the shoal user id. */
    publicKeyB64;
    constructor(seed) {
        this.signSeed = hkdf(sha256, seed, undefined, "shoal/v1/sign", 32);
        this.encKey = hkdf(sha256, seed, undefined, "shoal/v1/enc", 32);
        this.publicKeyB64 = b64url(ed25519.getPublicKey(this.signSeed));
    }
    static fromMnemonic(phrase) {
        const normalized = phrase.trim().toLowerCase();
        if (!validateMnemonic(normalized, wordlist)) {
            throw new Error("invalid recovery phrase");
        }
        return new SyncKeys(mnemonicToSeedSync(normalized));
    }
    static generateMnemonic() {
        return generateMnemonic(wordlist, 128);
    }
    /** AAD binds ciphertext to its record location: collection \0 record_id. */
    aad(collection, recordId) {
        const c = new TextEncoder().encode(collection);
        const r = new TextEncoder().encode(recordId);
        const out = new Uint8Array(c.length + 1 + r.length);
        out.set(c, 0);
        out[c.length] = 0;
        out.set(r, c.length + 1);
        return out;
    }
    /** Output is nonce || ciphertext, matching the other clients. */
    encrypt(plaintext, collection, recordId) {
        const nonce = randomBytes(24);
        const ct = xchacha20poly1305(this.encKey, nonce, this.aad(collection, recordId)).encrypt(plaintext);
        const out = new Uint8Array(24 + ct.length);
        out.set(nonce, 0);
        out.set(ct, 24);
        return out;
    }
    decrypt(blob, collection, recordId) {
        const nonce = blob.slice(0, 24);
        const ct = blob.slice(24);
        return xchacha20poly1305(this.encKey, nonce, this.aad(collection, recordId)).decrypt(ct);
    }
    /** Signature for request auth: method \n path \n timestamp \n hex(sha256(body)). */
    requestSignature(method, pathAndQuery, timestampSecs, body) {
        const bodyHash = hex(sha256(body));
        const msg = new TextEncoder().encode(`${method}\n${pathAndQuery}\n${timestampSecs}\n${bodyHash}`);
        return b64url(ed25519.sign(msg, this.signSeed));
    }
}
export function b64url(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
