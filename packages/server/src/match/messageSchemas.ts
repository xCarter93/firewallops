/**
 * Tightened inbound-message Zod schemas (Phase 3, Plan 03) — NET-07.
 *
 * Exported standalone so they are unit-testable WITHOUT instantiating a Room
 * (mirrors the headless pattern). The Room wraps each in the Colyseus
 * `validate(schema, handler)` helper; the schema layer rejects malformed /
 * out-of-range / unknown-itemId input BEFORE the handler runs.
 *
 * NET-07 boundary (Agreed Concern #5 / Authority Decision — tightened Zod):
 *   - `.finite()` rejects NaN / Infinity.
 *   - `.min(0).max(...)` clamps the numeric range (power > 100 rejected).
 *   - `z.enum([...])` makes `itemId` an ALLOW-LIST (an unknown id like "rocket"
 *     is rejected) rather than a free string.
 *
 * angleDeg is the ABSOLUTE sim angle (0 = right, 90 = up, 180 = left), so it is
 * bounded [0, 180]. power is the 0..100 charge.
 */
import { z } from "zod";

/** The three selectable shot ids — the loadout allow-list. */
export const ITEM_IDS = ["shot-1", "shot-2", "trojan"] as const;

/**
 * `fire`: commit a shot. `itemId` is the enum allow-list; power/angle are
 * finite-bounded. A `power: 101`, `NaN` angle, or unknown itemId is rejected
 * before any game logic.
 */
export const fireSchema = z.object({
  angleDeg: z.number().finite().min(0).max(180),
  power: z.number().finite().min(0).max(100),
  itemId: z.enum(ITEM_IDS),
});
export type FireMessage = z.infer<typeof fireSchema>;

/**
 * `aim`: stream the current aim. `committed` flags the explicit power-release
 * (drives `powerLocked` PRECISELY — Agreed Concern #6: locked ONLY on commit,
 * not merely power > 0).
 */
export const aimSchema = z.object({
  angleDeg: z.number().finite().min(0).max(180),
  power: z.number().finite().min(0).max(100),
  committed: z.boolean().optional(),
});
export type AimMessage = z.infer<typeof aimSchema>;

/** `selectItem`: switch the active shot. Same itemId allow-list. */
export const selectItemSchema = z.object({
  itemId: z.enum(ITEM_IDS),
});
export type SelectItemMessage = z.infer<typeof selectItemSchema>;

/**
 * `ready` / `unready` (Plan 04, LOBBY-04): a seated player toggles their lobby
 * ready flag in the WAITING phase. The intent IS the message name (ready vs
 * unready) — the body carries no fields. The client sends these payload-less
 * (`room.send("ready")`), so the schema MUST accept an absent payload:
 * `.optional()` lets Colyseus's standardValidate pass `undefined` (and a bare
 * `{}`) through. A plain `z.object({})` rejects `undefined` with
 * "expected object, received undefined" and crashes the handler.
 */
export const readySchema = z.object({}).optional();
export type ReadyMessage = z.infer<typeof readySchema>;

/**
 * `resetRange` (Phase 8, training only): the client requests a range reset
 * (fresh terrain + re-spawned dummy) payload-less (`room.send("resetRange")`).
 *
 * `.strict()` REJECTS any unexpected payload key (e.g. `{ foo: 1 }`) at the Zod
 * boundary rather than silently STRIPPING it (NET-07 discipline / Codex P2 — a
 * bare `z.object({})` only strips unknown keys, it does NOT reject them). Then
 * `.optional()` accepts the absent/`undefined` payload the payload-less client
 * send produces. CONSTRUCTION ORDER MATTERS: `.strict()` applies to the inner
 * object shape, `.optional()` makes the whole thing accept `undefined`, so
 * `z.object({}).strict().optional()` composes strict-on-unknown WITH
 * accept-undefined.
 *
 * The handler-level training gate (`if (!this.isTraining) return;`) lands in
 * Plan 02, so this message is inert in real matches; the strict-object closes the
 * spoofed-payload surface at the schema boundary (T-08-01).
 */
export const resetRangeSchema = z.object({}).strict().optional();
export type ResetRangeMessage = z.infer<typeof resetRangeSchema>;

/** Per-player explicit OUTCOME enum (Phase-5 Blocker 2 — NO boolean `won`). */
export const OUTCOMES = ["win", "loss", "draw", "abandon_loss"] as const;

/**
 * `POST /internal/match-results` body schema (review H7 + Phase-5 Blocker 2).
 *
 * The match-results write endpoint is service-to-service (gated by a shared
 * secret in routes.ts); this schema is the validation half — a request that fails
 * it is rejected with 400 before any record.
 *   - `winnerTeam` — the finite team index (-1 is the draw sentinel) kept for the
 *     broadcast/legacy path.
 *   - `resultId` — the EVENT-level idempotency key the route ledger de-dups on
 *     (`${roomId}:final` vs `${roomId}:abandon:${accountId}`), so the final and
 *     abandon writes are NOT collapsed by the route ledger.
 *   - `players` — per-player EXPLICIT outcomes (Blocker 2): each carries its OWN
 *     granular per-player+event `resultId` = `${roomId}:${event}:${accountId}` so
 *     the Convex `result_events` table dedups per player+event. NO boolean `won`,
 *     so a draw is `draw` (neither) and an abandon is `abandon_loss` (a loss) with
 *     no self-contradiction.
 */
export const matchResultSchema = z.object({
  winnerTeam: z.number().int(),
  resultId: z.string().min(1),
  players: z
    .array(
      z.object({
        accountId: z.string().min(1),
        outcome: z.enum(OUTCOMES),
        resultId: z.string().min(1),
      }),
    )
    .optional(),
});
export type MatchResultMessage = z.infer<typeof matchResultSchema>;
