import { describe, expect, it } from "vitest";
import { SyncKeys } from "../src/keys.js";

// The phrase used by the live cross-client test (Kotlin app on the emulator,
// Python reference client, Rust server). Its derived user id is the golden
// value all clients must agree on.
const PHRASE = "warm answer profit skate gift prison brother wild jar sing protect invest";
const GOLDEN_PUBKEY = "2giTflD2LrqkbMnESpjWmlzI0zpWzskgZCMmPfXnlxg";

describe("SyncKeys", () => {
  it("derives the same identity as the Kotlin and Python clients", () => {
    expect(SyncKeys.fromMnemonic(PHRASE).publicKeyB64).toBe(GOLDEN_PUBKEY);
  });

  it("is deterministic", () => {
    expect(SyncKeys.fromMnemonic(PHRASE).publicKeyB64).toBe(SyncKeys.fromMnemonic(PHRASE).publicKeyB64);
  });

  it("rejects a bad checksum", () => {
    expect(() => SyncKeys.fromMnemonic("abandon ".repeat(11) + "abandon")).toThrow();
  });

  it("generates a valid 12-word phrase", () => {
    const phrase = SyncKeys.generateMnemonic();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(() => SyncKeys.fromMnemonic(phrase)).not.toThrow();
  });

  it("encrypts and decrypts with record binding", () => {
    const keys = SyncKeys.fromMnemonic(PHRASE);
    const pt = new TextEncoder().encode('{"name":"road trip"}');
    const ct = keys.encrypt(pt, "mnemonic", "card/abc");
    expect(keys.decrypt(ct, "mnemonic", "card/abc")).toEqual(pt);
    expect(() => keys.decrypt(ct, "mnemonic", "card/OTHER")).toThrow();
  });

  it("cannot decrypt with a different phrase", () => {
    const a = SyncKeys.fromMnemonic(PHRASE);
    const b = SyncKeys.fromMnemonic(SyncKeys.generateMnemonic());
    const ct = a.encrypt(new TextEncoder().encode("data"), "mnemonic", "r/1");
    expect(() => b.decrypt(ct, "mnemonic", "r/1")).toThrow();
  });
});
