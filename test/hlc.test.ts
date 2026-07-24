import { describe, expect, it } from "vitest";
import { Hlc } from "../src/hlc.js";

describe("Hlc", () => {
  it("later wall clock sorts after earlier", () => {
    const hlc = new Hlc(1);
    const a = hlc.next(1000);
    const b = hlc.next(2000);
    expect(b > a).toBe(true);
  });

  it("stays monotonic within one millisecond", () => {
    const hlc = new Hlc(1);
    const stamps = Array.from({ length: 100 }, () => hlc.next(5000));
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("stays monotonic when the clock steps backwards", () => {
    const hlc = new Hlc(1);
    const a = hlc.next(9000);
    const b = hlc.next(100);
    expect(b > a).toBe(true);
  });

  it("observe folds remote time forward", () => {
    const hlc = new Hlc(1);
    hlc.next(1000);
    const remote = Hlc.encode(50_000, 0, 2);
    hlc.observe(remote);
    expect(hlc.next(1500) > remote).toBe(true);
  });

  it("matches the Kotlin encoding exactly", () => {
    expect(Hlc.encode(0xfff, 1, 3)).toBe("000000000fff-0001-00000003");
  });

  it("isNewer treats null as older and equal as not newer", () => {
    const stamp = Hlc.encode(1000, 0, 1);
    expect(Hlc.isNewer(stamp, null)).toBe(true);
    expect(Hlc.isNewer(stamp, stamp)).toBe(false);
  });
});
