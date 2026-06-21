/**
 * Pure per-client token bucket (H4) + message-size helper — Phase 5, Plan 02.
 *
 * APPLICATION-LAYER ABUSE GUARD, NOT A TRANSPORT BYTE CEILING (review MEDIUM).
 * Both the bucket and `withinSizeLimit` operate on the ALREADY-DECODED handler
 * payload — i.e. AFTER the frame has been parsed and a message object handed to
 * the room's message handler. They throttle abusive message *volume* and *size*
 * at the application boundary (the trust boundary where an untrusted client's
 * `aim`/`selectItem` stream crosses into authoritative room logic). They are
 * deliberately NOT a wire/transport decode-size boundary: the transport has
 * already decoded the frame before any handler — and therefore this module —
 * ever sees the payload, so this cannot and does not cap raw inbound bytes on
 * the socket. It is an app-level rate/size guard, nothing more.
 *
 * PURITY: this module imports NOTHING and reads NO ambient/wall clock. All time
 * enters through the injected `now` parameter (milliseconds). The caller (Plan
 * 04 wires this into `MatchRoom`) feeds `now` from `this.clock.currentTime` so
 * the bucket inherits the room's deterministic, test-injectable clock — there is
 * no hidden time source here, which is what keeps it deterministic under test.
 */

/**
 * A single deterministic token bucket. Tokens refill continuously at
 * `refillPerSec` up to `capacity`; each accepted message costs `cost` tokens.
 * The bucket holds no clock — every `take` is told the current `now`.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  /**
   * @param capacity     Max tokens (a burst of this many is allowed at once).
   * @param refillPerSec Tokens regained per second of elapsed `now`.
   * @param now          The current time (ms) at construction — sets the refill epoch.
   */
  constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /**
   * Attempt to consume `cost` tokens at time `now` (ms). Refills first based on
   * elapsed time (clamped to `capacity`), then accepts iff enough tokens remain.
   * Returns true on accept (tokens decremented) or false on reject (unchanged
   * except for the refill bookkeeping).
   */
  take(now: number, cost = 1): boolean {
    const elapsedSec = (now - this.last) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec,
    );
    this.last = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

/**
 * Pure size guard: true iff a serialized message's byte length is within `max`.
 * Run on the already-decoded payload's serialized size — an app-level size cap,
 * not a transport frame ceiling (see module head comment).
 */
export function withinSizeLimit(byteLength: number, max: number): boolean {
  return byteLength <= max;
}

/**
 * SEPARATE buckets for high- vs low-frequency messages (review LOW): one shared
 * default would be too coarse, since `aim` floods at the ~100ms client cadence
 * while `selectItem` is occasional. Plan 04 creates ONE aim-bucket and ONE
 * item-bucket per `sessionId`, each from the matching param pair below.
 */

/**
 * Aim bucket — high frequency. The client throttles `aim` to ~AIM_THROTTLE_MS
 * (100ms) ≈ 10 msg/s, so capacity 20 + 12/s refill leaves a normal aimer
 * comfortably untripped while still rejecting a sustained flood well above the
 * legitimate cadence.
 */
export const AIM_BUCKET_CAPACITY = 20;
export const AIM_BUCKET_REFILL_PER_SEC = 12;

/**
 * Item bucket — low frequency. `selectItem` is rare (a player picks a weapon
 * occasionally), so a tighter bucket is appropriate: a small burst allowance
 * with a slow refill.
 */
export const ITEM_BUCKET_CAPACITY = 8;
export const ITEM_BUCKET_REFILL_PER_SEC = 4;

/** App-level per-message byte cap (on the decoded payload). */
export const MAX_MESSAGE_BYTES = 1024;
