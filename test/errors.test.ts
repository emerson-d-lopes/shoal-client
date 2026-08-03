import { describe, expect, it } from "vitest";
import { ShoalError, parseRetryAfter } from "../src/errors.js";

describe("ShoalError", () => {
  it("marks refusals that will not change as terminal", () => {
    // A full server and a key the operator has not allowed both stay that way
    // until a human acts, so a retry loop must not treat them as transient.
    for (const status of [400, 401, 403, 507]) {
      expect(new ShoalError(status, "POST", "/v1/ops", "").terminal).toBe(true);
    }
  });

  it("leaves transient failures retryable", () => {
    for (const status of [429, 500, 502, 503, 413]) {
      expect(new ShoalError(status, "POST", "/v1/ops", "").terminal).toBe(false);
    }
  });

  it("flags the two statuses the push loop reacts to", () => {
    expect(new ShoalError(413, "POST", "/v1/ops", "").tooLarge).toBe(true);
    expect(new ShoalError(429, "POST", "/v1/ops", "").rateLimited).toBe(true);
    expect(new ShoalError(500, "POST", "/v1/ops", "").tooLarge).toBe(false);
  });

  it("keeps the response body for diagnosis but truncates the message", () => {
    const err = new ShoalError(500, "POST", "/v1/ops", "x".repeat(500));
    expect(err.body).toHaveLength(500);
    expect(err.message.length).toBeLessThan(300);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-27T10:00:00Z");

  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("  0 ", now)).toBe(0);
  });

  it("reads an HTTP date as a delay from now", () => {
    expect(parseRetryAfter("Mon, 27 Jul 2026 10:00:45 GMT", now)).toBe(45_000);
  });

  it("never returns a negative delay for a date already past", () => {
    expect(parseRetryAfter("Mon, 27 Jul 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined when there is no usable hint", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});
