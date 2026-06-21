import { describe, it, expect } from "vitest";
import {
  TokenBucket,
  withinSizeLimit,
  MAX_MESSAGE_BYTES,
  AIM_BUCKET_CAPACITY,
  AIM_BUCKET_REFILL_PER_SEC,
  ITEM_BUCKET_CAPACITY,
  ITEM_BUCKET_REFILL_PER_SEC,
} from "../src/ratelimit/tokenBucket.js";

/**
 * H4 per-client token bucket coverage — pure unit, no Room, no wall clock.
 * Every `take` is driven by a hand-advanced `now` (ms), so the reject/refill/
 * clamp behavior is fully deterministic (per the plan's injected-`now` rule).
 */
describe("TokenBucket", () => {
  it("grants exactly `capacity` immediate takes then rejects the next at the same now", () => {
    // Test 1: capacity-5 bucket → 5 immediate accepts, 6th rejected at now=0.
    const bucket = new TokenBucket(5, AIM_BUCKET_REFILL_PER_SEC, 0);
    for (let i = 0; i < 5; i++) {
      expect(bucket.take(0)).toBe(true);
    }
    // 6th at the SAME now (no refill) → rejected.
    expect(bucket.take(0)).toBe(false);
  });

  it("refills tokens as simulated time advances so a previously-rejected take succeeds", () => {
    // Test 2: drain the bucket, get a reject, then advance `now` enough to
    // refill at least one token and confirm the next take succeeds.
    const bucket = new TokenBucket(2, 4, 0); // 4 tokens/sec → 1 token per 250ms.
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false); // drained at now=0.

    // Advance 250ms → +1 token (4/sec * 0.25s). Now a take succeeds.
    expect(bucket.take(250)).toBe(true);
    // Drained again immediately.
    expect(bucket.take(250)).toBe(false);

    // Advance a full second → tokens clamp at capacity, take succeeds again.
    expect(bucket.take(1250)).toBe(true);
  });

  it("never exceeds capacity no matter how far now advances (clamp)", () => {
    // Test 3: huge elapsed time must not bank tokens beyond `capacity`.
    const cap = 3;
    const bucket = new TokenBucket(cap, 10, 0);
    // Jump far into the future — refill would be enormous if unclamped.
    // Only `cap` takes should succeed before a reject (proves the clamp).
    for (let i = 0; i < cap; i++) {
      expect(bucket.take(1_000_000)).toBe(true);
    }
    expect(bucket.take(1_000_000)).toBe(false);
  });

  it("withinSizeLimit returns false over the byte cap, true otherwise", () => {
    // Test 4: serialized-message byte cap helper.
    expect(withinSizeLimit(MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES)).toBe(true); // exactly at cap is OK.
    expect(withinSizeLimit(MAX_MESSAGE_BYTES - 1, MAX_MESSAGE_BYTES)).toBe(true);
    expect(withinSizeLimit(MAX_MESSAGE_BYTES + 1, MAX_MESSAGE_BYTES)).toBe(false);
    expect(withinSizeLimit(0, 10)).toBe(true);
    expect(withinSizeLimit(11, 10)).toBe(false);
  });

  it("exports separate high-frequency aim and low-frequency item bucket params (review LOW)", () => {
    // Separate buckets: the aim bucket is more generous (high cadence) than the
    // item bucket (rare). This pins that the two param sets are distinct and
    // ordered as intended so plan 04 wires the right pair to each message.
    expect(AIM_BUCKET_CAPACITY).toBeGreaterThan(ITEM_BUCKET_CAPACITY);
    expect(AIM_BUCKET_REFILL_PER_SEC).toBeGreaterThan(ITEM_BUCKET_REFILL_PER_SEC);

    // Sanity: a fresh aim bucket honors its own capacity.
    const aim = new TokenBucket(AIM_BUCKET_CAPACITY, AIM_BUCKET_REFILL_PER_SEC, 0);
    for (let i = 0; i < AIM_BUCKET_CAPACITY; i++) {
      expect(aim.take(0)).toBe(true);
    }
    expect(aim.take(0)).toBe(false);
  });
});
