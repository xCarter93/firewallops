import { Client, Room } from "@colyseus/sdk";
import { decodeMaskRLE } from "@shared/sim";
import type { TerrainMask } from "@shared/sim";
import type { ShotResult } from "../match/shotResult.js";

/**
 * Colyseus client net layer (Phase 3, plan 04) — NET-01 / NET-06.
 *
 * The ONLY place the client talks to the authoritative server. It connects,
 * joins the hardcoded "match" room, registers the inbound listeners, and exposes
 * thin send wrappers. The server is the SOLE authority: HP, terrain, turn, wind
 * and phase all arrive here as broadcasts/state and are forwarded verbatim to
 * the scene handlers — this module NEVER decides an outcome.
 *
 * SEAM DISCIPLINE (ESLint guard on net/**): net/ consumes server broadcasts
 * only. It MUST NEVER call resolveShot/simulateTrajectory/quantizeCarve — the
 * server is the authority. decodeMaskRLE (NOT an outcome function) is allowed
 * for the one-time join snapshot.
 *
 * Client SDK is `@colyseus/sdk` 0.17 — NOT `colyseus.js` (frozen 0.16). The
 * inbound terrainSnapshot payload is a Uint8Array VIEW into the frame buffer, so
 * we coerce it with `new Uint8Array(payload)` before decoding (see toUint8Array).
 */

/** The dev server address (Plan 03). Making this configurable is a Phase 4 concern. */
export const SERVER_URL = "ws://localhost:2567";

/**
 * The concrete handlers the scene supplies. The net layer forwards each server
 * broadcast / state change to exactly one of these — no logic, no mutation.
 */
export interface NetHandlers {
  /** NET-01: the SOLE shot-outcome source. HP/terrain change ONLY from this. */
  onShotResult(result: ShotResult): void;
  /** Rebuild the visual terrain from the decoded join snapshot (NET-05). */
  onTerrainSnapshot(mask: TerrainMask): void;
  /** Team-or-draw match end (winnerTeam -1 / draw === true is a draw). */
  onMatchEnded(winnerTeam: number, draw: boolean): void;
  /** Full synced MatchState on every patch (HP/wind/phase/activePlayer/turnEndsAt/mobiles). */
  onStateChange(state: unknown): void;
}

/**
 * Coerce the inbound terrainSnapshot payload into a tight, owned Uint8Array.
 *
 * The server sends the snapshot via `client.sendBytes("terrainSnapshot", u8)`;
 * the @colyseus/sdk delivers it as a Uint8Array VIEW (`buffer.subarray(offset)`)
 * whose byteOffset is > 0. `new Uint8Array(payload)` copies just the payload's
 * logical bytes (element-by-element from payload[0]) — it does NOT pull in the
 * rest of the frame. We also tolerate the `send(number[])` fallback shape and a
 * raw ArrayBuffer, so the decode is robust regardless of transport encoding.
 */
function toUint8Array(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return new Uint8Array(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  // ArrayBufferView fallback (e.g. a DataView / typed array of another kind).
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  throw new Error("terrainSnapshot: unrecognized byte payload shape");
}

/**
 * Connect to the dev server and join (or create) the "match" room as a guest
 * (no token this phase). Registers all inbound listeners against the supplied
 * handlers and returns the live Room (the scene stores it + its sessionId for
 * the input gate, and sends aim/fire through it).
 */
export async function connectToMatch(handlers: NetHandlers): Promise<Room> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate("match", {});

  // NET-01: the authoritative shot outcome — the SOLE mutation trigger.
  room.onMessage("shotResult", (result: ShotResult) =>
    handlers.onShotResult(result),
  );

  // NET-05: the one-time RLE terrain snapshot (raw bytes). Coerce the view to an
  // owned Uint8Array, then decode it into a TerrainMask for the visual rebuild.
  room.onMessage("terrainSnapshot", (payload: unknown) =>
    handlers.onTerrainSnapshot(decodeMaskRLE(toUint8Array(payload))),
  );

  // Team-or-draw banner. The server's draw broadcast is `{ winnerTeam: -1, draw: true }`.
  room.onMessage(
    "matchEnded",
    (payload: { winnerTeam: number; draw?: boolean }) =>
      handlers.onMatchEnded(payload.winnerTeam, payload.draw === true),
  );

  // The full synced state on every patch — HP, wind, phase, activePlayer,
  // turnEndsAt, mobiles. syncFromState is the SOLE driver of turn/wind/HP/phase.
  room.onStateChange((state: unknown) => handlers.onStateChange(state));

  return room;
}

/**
 * Stream the current aim to the server. `angleDeg` is the ABSOLUTE sim angle
 * (0..180) the server schema validates — the scene passes `absoluteAngle(facing)`,
 * NOT the raw 0..90 relative aim. The `committed` flag drives the server's
 * precise `powerLocked` semantics (Agreed Concern #6): true ONLY on the
 * power-release / fire-commit gesture, never on every throttled mid-charge tick.
 */
export function sendAim(
  room: Room,
  angleDeg: number,
  power: number,
  committed = false,
): void {
  room.send("aim", { angleDeg, power, committed });
}

/**
 * Fire the committed shot. `angleDeg` is the ABSOLUTE sim angle (0..180).
 * The controller's injected fireSender wires to this so `applyShot` forwards to
 * the net layer (the seam stays live; Authority Decision 7).
 */
export function sendFire(
  room: Room,
  angleDeg: number,
  power: number,
  itemId: string,
): void {
  room.send("fire", { angleDeg, power, itemId });
}

/**
 * Tell the server the player's current weapon pick (NET-02). Without this the
 * server's `Mobile.selectedItemId` keeps its default `shot-1`, so a turn-timeout
 * auto-fire (NET-04) would fire the wrong shot. The message name "selectItem"
 * and the `{ itemId }` payload shape MUST match the server's selectItemSchema.
 */
export function sendSelectItem(room: Room, itemId: string): void {
  room.send("selectItem", { itemId });
}
