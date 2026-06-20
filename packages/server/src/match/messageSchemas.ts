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
 * `POST /internal/match-results` body schema (review H7).
 *
 * The match-results write endpoint is service-to-service (gated by a shared
 * secret in routes.ts); this schema is the validation half — a request that fails
 * it is rejected with 400 before any record. `winnerTeam` is the finite team
 * index (-1 is the draw sentinel the room uses). `resultId` is the REQUIRED
 * idempotency key the route de-dups on so a retried/duplicate write is a no-op.
 */
export const matchResultSchema = z.object({
  winnerTeam: z.number().int(),
  resultId: z.string().min(1),
});
export type MatchResultMessage = z.infer<typeof matchResultSchema>;
