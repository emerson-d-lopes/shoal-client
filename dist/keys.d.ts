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
export declare class SyncKeys {
    private readonly signSeed;
    private readonly encKey;
    /** base64url(ed25519 public key) — the shoal user id. */
    readonly publicKeyB64: string;
    private constructor();
    static fromMnemonic(phrase: string): SyncKeys;
    static generateMnemonic(): string;
    /** AAD binds ciphertext to its record location: collection \0 record_id. */
    private aad;
    /** Output is nonce || ciphertext, matching the other clients. */
    encrypt(plaintext: Uint8Array, collection: string, recordId: string): Uint8Array;
    decrypt(blob: Uint8Array, collection: string, recordId: string): Uint8Array;
    /** Signature for request auth: method \n path \n timestamp \n hex(sha256(body)). */
    requestSignature(method: string, pathAndQuery: string, timestampSecs: number, body: Uint8Array): string;
}
export declare function b64url(bytes: Uint8Array): string;
export declare function b64urlDecode(s: string): Uint8Array;
