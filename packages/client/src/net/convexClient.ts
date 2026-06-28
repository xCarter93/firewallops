import { ConvexClient } from "convex/browser";
import { api } from "@firewallops/convex/api";
import { decodeMaskRLE } from "@shared/sim";
import type { TerrainMask } from "@shared/sim";
import type { ShotResult } from "../match/shotResult.js";
import {
  convexDocToSyncedState,
  type ConvexMatchDoc,
} from "./convexDocToSyncedState.js";

/**
 * Convex client net layer (Phase 9, plan 06) — the pure-Convex replacement for the
 * Colyseus `net/room.ts` transport. It is the ONLY place the client talks to the
 * authoritative Convex backend (plans 04-05): it subscribes to the reactive match
 * doc via `ConvexClient.onUpdate(api.match.get)`, maps it through the pure
 * `convexDocToSyncedState` adapter into the SAME `NetHandlers` seams the scene
 * already consumes, and exposes thin intention wrappers over `client.mutation`. The
 * Convex authority is the SOLE authority: HP, terrain, turn, wind and phase all
 * arrive here on the doc and are forwarded verbatim to the scene — this module
 * NEVER decides an outcome (it imports `decodeMaskRLE` only — NOT an outcome
 * function — for the terrain snapshot decode).
 *
 * COEXISTENCE: `net/room.ts` (Colyseus) is NOT deleted here — both transports live
 * on the branch until the plan-12 cutover, after all four modes verify green.
 *
 * REVIEW FINDINGS:
 *  - [I] `api.match.get` returns the caller's own `localMobileId` (the seat id whose
 *    `accountId` matched the verified subject — `accountId` never crosses the wire).
 *    convexClient surfaces it via `handlers.onLocalIdentity(localMobileId)` so the
 *    scene can gate input on it (the Convex replacement for `room.sessionId`).
 *  - [H] out-of-turn fire no longer gets a server `fireRejected` message (Convex
 *    `fireShot` no-ops out-of-turn, plan 05). The `setShellFireRejectedHook` /
 *    `notifyShellFireRejected` fan-out is PRESERVED here unchanged; its trigger
 *    moves client-side (MatchScene pre-checks phase/active before firing — Task 4 —
 *    and invokes `notifyShellFireRejected(reason)` so the same rejection UX fires).
 *  - DROPPED (D9, no seat in Convex): all reconnection-token / seat-handoff
 *    machinery (`recoKey`, `persistReconnectToken`, `reconnectToMatch`, the
 *    `attachToMatch` provide/take WeakMap). A returning client just re-subscribes.
 */

/**
 * The build-time-injected Convex deployment URL. Vite inlines `import.meta.env.
 * VITE_*` at build (a runtime env is `undefined` in a built static bundle), so a
 * PRODUCTION build with a missing/empty `VITE_CONVEX_URL` throws loudly — a
 * misconfigured deploy fails fast rather than pointing the bundle at nothing. DEV
 * may set it in the client `.env`. (Mirrors `resolveServerUrl` in net/room.ts.)
 */
function resolveConvexUrl(): string {
  const envUrl = import.meta.env.VITE_CONVEX_URL;
  if (import.meta.env.PROD && (envUrl === undefined || envUrl.trim() === "")) {
    throw new Error(
      "VITE_CONVEX_URL is required for a production build (the deployed Convex " +
        "deployment URL must be baked in at build time). Refusing to start " +
        "without it. Set VITE_CONVEX_URL in the Vercel build env.",
    );
  }
  if (envUrl === undefined || envUrl.trim() === "") {
    throw new Error(
      "VITE_CONVEX_URL is required — the client subscribes to the Convex " +
        "authority and cannot connect without it. Set it in the client .env " +
        "(see .env.example). Convex Dashboard → Settings → URL & Deploy Key.",
    );
  }
  return envUrl;
}

/**
 * The single ConvexClient for the session. Lazily constructed so that importing
 * this module (e.g. for the intention wrappers) does not require `VITE_CONVEX_URL`
 * at module-eval time — only the first network use does.
 */
let _client: ConvexClient | null = null;

/** The shared ConvexClient (constructed on first use). */
export function getConvexClient(): ConvexClient {
  if (!_client) {
    _client = new ConvexClient(resolveConvexUrl());
  }
  return _client;
}

/**
 * Wire the Clerk 'convex' JWT template token onto the Convex client (review T-09-12).
 * The client ONLY supplies the token; it never asserts identity claims — Convex
 * verifies the issuer (auth.config.ts, plan 03) and reads `getUserIdentity().subject`
 * server-side. `fetchToken` is the `shell/auth.ts` `getConvexToken` helper.
 *
 * Pitfall (R6): the Clerk `convex` JWT template MUST exist or `getUserIdentity()` is
 * null. The live-sub PROOF (a signed-in browser making the first authed call) is a
 * founder action at the 09-07 browser E2E gate — GATE-AUTH.
 */
export function setConvexAuth(
  fetchToken: (opts: {
    forceRefreshToken: boolean;
  }) => Promise<string | null | undefined>,
): void {
  getConvexClient().setAuth(fetchToken);
}

/**
 * The concrete handlers the scene supplies — the SAME contract `net/room.ts`
 * `NetHandlers` defined (the scene consumes these unchanged), plus `onLocalIdentity`
 * for the Convex `localMobileId` ([I]).
 */
export interface ConvexNetHandlers {
  /** NET-01: the SOLE shot-outcome source. HP/terrain change ONLY from this. */
  onShotResult(result: ShotResult): void;
  /** Rebuild the visual terrain from the decoded snapshot (join / version jump). */
  onTerrainSnapshot(mask: TerrainMask): void;
  /** Team-or-draw match end (winnerTeam -1 / draw === true is a draw). */
  onMatchEnded(winnerTeam: number, draw: boolean): void;
  /** Full synced MatchState on every doc patch (already mapped to SyncedState). */
  onStateChange(state: unknown): void;
  /**
   * [I] the caller's own seat id (`localMobileId` from `api.match.get`), fired once
   * it is known (and again if it changes). Replaces Colyseus `room.sessionId` for
   * input gating. Optional so inert handlers need not implement it.
   */
  onLocalIdentity?(localMobileId: string): void;
  /**
   * [H] out-of-turn / wrong-phase fire UX. Convex `fireShot` no-ops out-of-turn, so
   * the trigger moves client-side; this is the same hook the old server
   * `fireRejected` drove. Optional (inert handlers omit it).
   */
  onFireRejected?(reason: string): void;
}

/**
 * Coerce a `v.bytes()` payload (the `matchTerrain.rle` round-trip) into a tight,
 * owned Uint8Array before `decodeMaskRLE` (RESEARCH Pitfall 5 — the byteOffset
 * hazard). Reused VERBATIM from `net/room.ts:86-96`: a typed-array VIEW with a
 * non-zero byteOffset would otherwise decode garbage. `convex/values` delivers
 * `v.bytes()` as an `ArrayBuffer`, but we tolerate every shape defensively.
 */
function toUint8Array(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return new Uint8Array(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  throw new Error("terrain snapshot: unrecognized byte payload shape");
}

// ───────────────────────────── shell fan-out hooks ─────────────────────────────
// PRESERVED from net/room.ts (the play-page banner/toast consumers survive). Only
// the TRIGGER of the fire-rejected hook moves client-side ([H]); the match-end hook
// is fanned out by MatchScene.onMatchEnded exactly as before.

/** The shell's post-match banner hook (UI-SPEC #9). */
let shellMatchEndHook: ((winnerTeam: number, draw: boolean) => void) | null =
  null;

/** Register the shell-side post-match callback (the play page's banner). */
export function setShellMatchEndHook(
  cb: ((winnerTeam: number, draw: boolean) => void) | null,
): void {
  shellMatchEndHook = cb;
}

/** Invoked by MatchScene.onMatchEnded to fan the match-end out to the shell. */
export function notifyShellMatchEnded(winnerTeam: number, draw: boolean): void {
  shellMatchEndHook?.(winnerTeam, draw);
}

/**
 * The shell's fire-rejected hook ([H]). PRESERVED unchanged — the play page renders
 * the brief DOM toast. With Convex, MatchScene's fire-button pre-check (Task 4)
 * invokes `notifyShellFireRejected(reason)` directly when the fire is not allowed,
 * since Convex `fireShot` silently no-ops out-of-turn instead of sending a message.
 */
let shellFireRejectedHook: ((reason: string) => void) | null = null;

/** Register the shell-side fire-rejected callback (the play page's toast). */
export function setShellFireRejectedHook(
  cb: ((reason: string) => void) | null,
): void {
  shellFireRejectedHook = cb;
}

/** Invoked to fan a fire-rejection out to the shell toast ([H], trigger client-side). */
export function notifyShellFireRejected(reason: string): void {
  shellFireRejectedHook?.(reason);
}

/**
 * The `lastShot` object on the Convex `matches` doc — the EXACT @shared/sim shapes
 * (schema.ts:72-90). It IS the `ShotResult` the scene's `animateShot` consumes
 * (path/impact/carves/damage), with `seq`/`byMobileId` envelope fields.
 */
interface ConvexLastShot extends ShotResult {
  seq: number;
  byMobileId: string;
}

/** The reactive doc shape `api.match.get` returns (mapper input + the extras). */
interface SubscribedDoc extends ConvexMatchDoc {
  lastShot?: ConvexLastShot | null;
  terrainVersion?: number;
  winnerTeam: number;
  status?: string;
}

/**
 * Subscribe to the reactive match doc — the replacement for `room.onStateChange`.
 *
 * On every doc patch it:
 *  1. surfaces the caller `localMobileId` once known ([I] — `onLocalIdentity`),
 *  2. feeds `convexDocToSyncedState(doc)` into `onStateChange` (the SOLE turn/wind/
 *     HP/phase driver — MatchScene.syncFromState),
 *  3. on a `lastShot.seq` INCREMENT, fires `onShotResult` (the same entry the old
 *     `onMessage("shotResult")` drove → `animateShot`),
 *  4. on a `terrainVersion` JUMP, pulls `api.match.getTerrain`, decodes the RLE via
 *     the byteOffset-safe `toUint8Array`, and fires `onTerrainSnapshot` (R7),
 *  5. on a terminal RESULTS doc, fires `onMatchEnded(winnerTeam, draw)`.
 *
 * Returns an unsubscribe disposer (called on scene SHUTDOWN). Staleness is tracked
 * per-subscription via the closed-over `lastSeenShotSeq` / `lastSeenTerrainVersion`.
 */
export function subscribeMatch(
  matchId: string,
  handlers: ConvexNetHandlers,
): () => void {
  const client = getConvexClient();
  let lastSeenShotSeq = -1;
  let lastSeenTerrainVersion = -1;
  let lastLocalId: string | null = null;
  let endedFired = false;
  // Serialize terrain pulls so a burst of version jumps doesn't race the decode.
  let terrainPull: Promise<void> = Promise.resolve();

  const unsub = client.onUpdate(
    api.match.get,
    { matchId: matchId as unknown as never },
    (raw) => {
      // The inferred return is the full doc; narrow to the fields we read. The
      // `get` query already strips accountId + appends localMobileId (plan 04).
      const doc = raw as SubscribedDoc | null;
      if (!doc) return;

      // [I] surface the caller's own seat id (once, and again if it changes).
      if (doc.localMobileId && doc.localMobileId !== lastLocalId) {
        lastLocalId = doc.localMobileId;
        handlers.onLocalIdentity?.(doc.localMobileId);
      }

      // The SOLE turn/wind/HP/phase driver (replaces room.onStateChange).
      handlers.onStateChange(convexDocToSyncedState(doc));

      // lastShot.seq increment → the same animateShot entry as the old shotResult.
      const shot = doc.lastShot;
      if (shot && shot.seq !== lastSeenShotSeq) {
        lastSeenShotSeq = shot.seq;
        handlers.onShotResult(shot);
      }

      // terrainVersion jump → getTerrain → decodeMaskRLE → onTerrainSnapshot (R7).
      const ver = doc.terrainVersion ?? 0;
      if (ver !== lastSeenTerrainVersion) {
        lastSeenTerrainVersion = ver;
        terrainPull = terrainPull.then(async () => {
          try {
            const snap = await getTerrain(matchId);
            if (snap) handlers.onTerrainSnapshot(snap);
          } catch (err) {
            console.error("[convex] getTerrain failed", err);
          }
        });
      }

      // Terminal RESULTS → the match-end banner (winnerTeam -1 ⇒ draw). Fire once.
      if (doc.phase === "RESULTS" && !endedFired) {
        endedFired = true;
        handlers.onMatchEnded(doc.winnerTeam, doc.winnerTeam < 0);
      }
    },
  );

  return unsub;
}

/**
 * One-shot RLE terrain snapshot (join / version jump). Pulls `api.match.getTerrain`
 * and decodes it into a `TerrainMask` via the byteOffset-safe `toUint8Array`
 * (Pitfall 5). Returns `null` when the match/terrain row is absent.
 */
export async function getTerrain(matchId: string): Promise<TerrainMask | null> {
  const snap = (await getConvexClient().query(api.match.getTerrain, {
    matchId: matchId as unknown as never,
  })) as { version: number; rle: ArrayBuffer } | null;
  if (!snap) return null;
  return decodeMaskRLE(toUint8Array(snap.rle));
}

// ─────────────────────────── intention wrappers (mutations) ───────────────────────────
// Thin send wrappers over client.mutation — the scene/pages call THESE, never the
// raw client. Identity is derived server-side from the verified subject (D-08); no
// client-sent accountId/mobileId is trusted. (Mirror the room.ts wrapper surface.)

/** Fire the committed shot. The server re-derives every outcome (plan 05). */
export async function fireShot(
  matchId: string,
  angleDeg: number,
  power: number,
  itemId: string,
): Promise<void> {
  await getConvexClient().mutation(api.match.fireShot, {
    matchId: matchId as unknown as never,
    angleDeg,
    power,
    itemId,
  });
}

/** Tell the server the player's current weapon pick (NET-02). */
export async function selectItem(
  matchId: string,
  itemId: string,
): Promise<void> {
  await getConvexClient().mutation(api.match.selectItem, {
    matchId: matchId as unknown as never,
    itemId,
  });
}

/** Flip the caller's ready flag (WAITING-only; may auto-start). */
export async function toggleReady(
  matchId: string,
  ready: boolean,
): Promise<void> {
  await getConvexClient().mutation(api.match.toggleReady, {
    matchId: matchId as unknown as never,
    ready,
  });
}

/** Training-only RESET (TR-9/TR-10) — server rebuilds the range; inert elsewhere. */
export async function resetRange(matchId: string): Promise<void> {
  await getConvexClient().mutation(api.match.resetRange, {
    matchId: matchId as unknown as never,
  });
}

/** Create a NEW match room (lobby CREATE ROOM). Returns the new matchId. */
export async function createRoom(name: string, mode: string): Promise<string> {
  const id = await getConvexClient().mutation(api.match.createRoom, {
    name,
    mode,
  });
  return id as unknown as string;
}

/** Join a SPECIFIC existing match by id (share-link / lobby join). */
export async function joinMatch(matchId: string): Promise<void> {
  await getConvexClient().mutation(api.match.joinMatch, {
    matchId: matchId as unknown as never,
  });
}

/** Leave the current match (abandon-loss + forfeit for a live real match). */
export async function leaveMatch(matchId: string): Promise<void> {
  await getConvexClient().mutation(api.match.leaveMatch, {
    matchId: matchId as unknown as never,
  });
}
