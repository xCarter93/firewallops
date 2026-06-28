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
 * Module-level handoff of the CURRENT Convex matchId from the shell to the Phaser
 * scene — the Convex analog of `room.ts`'s `provideMatchRoom`/`takeProvidedMatchRoom`
 * (Blocker 3). For the TRAINING route (plan 07), the play page reads the matchId it is
 * entering (`convexMatchSession.currentMatchId`) and calls `provideConvexMatch(matchId)`
 * BEFORE instantiating Phaser. `MatchScene.createNetworked` then calls
 * `takeProvidedConvexMatch()`: if a matchId is present, the scene drives off the Convex
 * subscription (subscribe + `setLocalMobileId` + the Convex fire sender) INSTEAD of the
 * Colyseus `connectToMatch`/adopt path. `take` is one-shot (clears the slot) so a
 * standalone `VITE_NETWORKED` Colyseus dev boot still falls through to the room path.
 *
 * COEXISTENCE: this is purely ADDITIVE — when no Convex matchId is provided (every
 * multiplayer route until plan 08, and the dev boot), the scene's existing Colyseus
 * binding is untouched. Only the TRAINING route provides a Convex matchId for now.
 */
let providedConvexMatchId: string | null = null;

/** Hand the matchId the play page is entering to the next MatchScene boot (training). */
export function provideConvexMatch(matchId: string): void {
  providedConvexMatchId = matchId;
}

/** Take (and clear) the provided Convex matchId, or `null` if none was provided. */
export function takeProvidedConvexMatch(): string | null {
  const id = providedConvexMatchId;
  providedConvexMatchId = null;
  return id;
}

/**
 * LIVE LOCAL-AIM MIRROR for the DOM HUD action bar on the Convex route.
 *
 * Convex (unlike Colyseus) does NOT stream aim, so the synced `matches` doc's
 * `power`/`angleDeg` only change on FIRE — the DOM HUD's power meter would sit
 * frozen while the player charges. The scene writes the LOCAL player's live charge
 * here every frame (`setLiveAim`) while it is the local player's aiming turn, and
 * the play-page HUD binding reads it (`getLiveAim`) to override the action bar so
 * the meter fills live. `active:false` falls back to the synced value (post-fire /
 * opponent turn). Cosmetic-only — it NEVER affects what `fireShot` sends.
 */
export interface LiveAim {
  active: boolean;
  power: number;
  angleDeg: number;
}
const _liveAim: LiveAim = { active: false, power: 0, angleDeg: 0 };

/** Scene → HUD: publish the local player's live aim (or `{active:false}` when idle). */
export function setLiveAim(next: LiveAim): void {
  _liveAim.active = next.active;
  _liveAim.power = next.power;
  _liveAim.angleDeg = next.angleDeg;
}

/** HUD → read the current live local aim mirror. */
export function getLiveAim(): LiveAim {
  return _liveAim;
}

/**
 * SHOT-HOLD MIRROR for the DOM HUD turn-row HP on the Convex route.
 *
 * Convex resolves a shot in ONE doc write — the reduced HP rides the SAME patch as
 * the new `lastShot.seq`. The scene's canvas defers the HP-bar drop + body-settle
 * until the projectile lands (its `isAnimatingShot` gate), but the DOM HUD is a
 * SEPARATE read-only subscription that renders the raw doc HP immediately — so its
 * turn-row HP number would drop the instant you fire, before the shot visually
 * lands. While a shot animates, the scene publishes the PRE-shot HP per mobile here
 * (`setShotHold`), and the play-page HUD binding reads it (`getShotHold`) to hold
 * each row's HP/eliminated at the pre-shot value until the projectile lands, when
 * the scene clears it (`active:false`) and the real drop + red pulse fire together
 * with the canvas. Cosmetic-only — it NEVER affects authority or what `fireShot`
 * sends; it only re-times the HUD's HP readout to match the impact.
 */
export interface ShotHold {
  active: boolean;
  /** mobileId → the HP to DISPLAY while the shot is in flight (pre-shot value). */
  hp: Record<string, number>;
}
const _shotHold: ShotHold = { active: false, hp: {} };

/** Scene → HUD: hold turn-row HP at the pre-shot snapshot until the shot lands. */
export function setShotHold(active: boolean, hp?: Record<string, number>): void {
  _shotHold.active = active;
  _shotHold.hp = active && hp ? hp : {};
}

/** HUD → read the current shot-hold mirror. */
export function getShotHold(): ShotHold {
  return _shotHold;
}

/**
 * Non-consuming peek: is a Convex matchId currently provided? `MatchScene.create`
 * uses this to choose the networked boot path (the Convex training route runs with
 * `VITE_NETWORKED` off — the default dev flag), WITHOUT consuming the slot, which
 * `createNetworked` then `take`s. (A peek + a later take keeps the one-shot handoff.)
 */
export function hasProvidedConvexMatch(): boolean {
  return providedConvexMatchId !== null;
}

// ───────────────────────────── presence heartbeat (D-05, EMIT only) ─────────────────────────────
//
// The pure-Convex replacement for the deleted Colyseus socket-drop signal
// (`onDrop`/`onReconnect`). The client's ONLY presence job is to EMIT its own
// liveness for the active match — an interval heartbeat plus a tab-close beacon —
// against the `@convex-dev/presence`-backed `api.presence.heartbeat`/`disconnect`
// mutations (presence.ts). The server then re-derives `mobiles[].connected`
// AUTHORITATIVELY onto the match doc ([R], presence.ts:reconcileConnected), so the
// client NEVER merges presence into `convexDocToSyncedState`: `mobile.connected`
// already arrives on the synced doc and flows through the UNCHANGED
// `MatchScene` `view.setConnected(...)` binding. The per-user key (the seat
// `mobileId`) is resolved SERVER-SIDE from the verified subject — the client never
// names a mobileId, so it cannot heartbeat as another player (T-09-18).
//
// Heartbeat cadence is the component default (~5s, throttled — T-09-19); there are
// no per-frame writes. The `sessionId` is a per-tab random id so two tabs of the
// same account are distinct presence sessions (closing one does not mark the other
// absent — the component unions a user's sessions).

/** Heartbeat cadence (ms). Matches the @convex-dev/presence default (~5s, throttled). */
const PRESENCE_HEARTBEAT_MS = 5000;

/** A per-tab presence session id (distinguishes two tabs of the same account). */
function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Start emitting presence heartbeats for `matchId` and wire the tab-close beacon.
 * Returns a disposer that stops the interval and removes the lifecycle listeners.
 * EMIT only — reads come off the authoritative synced doc ([R]).
 *
 * - interval heartbeat → `api.presence.heartbeat` (keeps the session present),
 * - `visibilitychange:hidden` / `pagehide` → `api.presence.disconnect` so the
 *   opponent sees AWAY immediately rather than waiting out the heartbeat timeout.
 *
 * A non-member heartbeat is a server-side no-op (presence.ts), so this is safe to
 * start before the caller's seat is even known; the first patch with our
 * `localMobileId` is irrelevant to emission (the server resolves our seat itself).
 */
function startPresenceHeartbeat(matchId: string): () => void {
  const client = getConvexClient();
  const sessionId = newSessionId();
  let sessionToken = "";
  let stopped = false;
  // Pause the interval heartbeat while the tab is hidden. Chrome THROTTLES (≈1/s)
  // but does not stop background intervals, so without this the next throttled
  // beat re-asserts presence ~1s after the visibility-driven disconnect and
  // un-dims us instantly — the AWAY cue would flicker sub-second and never show.
  let paused = false;

  const beat = (): void => {
    if (stopped || paused) return;
    void client
      .mutation(api.presence.heartbeat, {
        matchId: matchId as unknown as never,
        sessionId,
        interval: PRESENCE_HEARTBEAT_MS,
      })
      .then((tokens) => {
        const t = tokens as { sessionToken?: string } | undefined;
        if (t?.sessionToken) sessionToken = t.sessionToken;
      })
      .catch((err: unknown) => {
        console.error("[convex] presence heartbeat failed", err);
      });
  };

  // Emit the explicit AWAY signal on tab-close/hide. `visibilitychange:hidden`
  // fires reliably as the page is backgrounded (the case the founder tests on two
  // devices); `pagehide` covers an actual unload. Both call `disconnect` so the
  // opponent dims at once instead of waiting the heartbeat-timeout window.
  const sendDisconnect = (): void => {
    void client
      .mutation(api.presence.disconnect, {
        matchId: matchId as unknown as never,
        sessionToken,
      })
      .catch(() => {
        /* best-effort on teardown; the heartbeat timeout is the backstop. */
      });
  };

  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      // Hidden/minimized → STOP heartbeating (so the throttled interval can't
      // re-assert presence) AND signal AWAY at once so the opponent dims now.
      paused = true;
      sendDisconnect();
    } else {
      // Returned to the tab → resume presence immediately (un-dim sooner).
      paused = false;
      beat();
    }
  };

  beat(); // present at once on subscribe (don't wait a full interval).
  const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS) as unknown as number;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", sendDisconnect);
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", sendDisconnect);
    }
    // Mark ourselves absent on an in-app unsubscribe (scene shutdown / leave) so
    // the opponent does not wait out the heartbeat timeout when we navigate away.
    sendDisconnect();
  };
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
 * It ALSO starts the presence heartbeat for the active match (D-05, EMIT only) and
 * stops it in the returned disposer — so presence is bound exactly to the live
 * subscription lifecycle (scene SHUTDOWN / leave both run the disposer). Reads of
 * `connected` come off the authoritative synced doc, NOT from presence ([R]).
 *
 * Returns an unsubscribe disposer (called on scene SHUTDOWN). Staleness is tracked
 * per-subscription via the closed-over `lastSeenShotSeq` / `lastSeenTerrainVersion`.
 */
export function subscribeMatch(
  matchId: string,
  handlers: ConvexNetHandlers,
  opts?: { presence?: boolean; terrain?: boolean },
): () => void {
  const client = getConvexClient();
  let lastSeenShotSeq = -1;
  let lastSeenTerrainVersion = -1;
  let lastLocalId: string | null = null;
  let endedFired = false;
  // First-snapshot guard: the initial doc after (re)subscribe may already carry a
  // resolved lastShot (join / reconnect mid-match) — seed the baseline from it
  // WITHOUT replaying that already-happened shot.
  let initialized = false;
  // Disposed guard: a terrain pull queued before teardown must not call back into a
  // torn-down scene after the disposer runs.
  let disposed = false;
  // Serialize terrain pulls so a burst of version jumps doesn't race the decode.
  let terrainPull: Promise<void> = Promise.resolve();

  // D-05: start emitting presence heartbeats for this match (EMIT only — [R]).
  // A read-only secondary subscriber (e.g. play.ts's DOM-HUD feed) passes
  // presence:false so it never opens a second heartbeat session for the same seat —
  // the scene's primary subscription owns the single heartbeat.
  const stopPresence =
    opts?.presence === false ? () => {} : startPresenceHeartbeat(matchId);

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

      // SHOT-BEFORE-STATE ORDERING (impact-timing fix). A lastShot.seq increment
      // must fire onShotResult → animateShot — which arms the scene's
      // `isAnimatingShot` gate — BEFORE onStateChange feeds this patch's reduced
      // HP/position. On the Colyseus path the `shotResult` MESSAGE naturally arrived
      // before the HP state patch, so syncFromState's `if (!isAnimatingShot)` gate
      // deferred the HP drop + body-settle to the projectile's land callback. Convex
      // resolves the shot in ONE doc write (reduced HP and the new lastShot.seq ride
      // the same patch), so we must replicate that order by hand: animate first
      // (arming the gate), THEN sync. Without this the opponent's HP drops and body
      // settles the instant you fire, before the projectile visually lands.
      //
      // The FIRST snapshot after (re)subscribe seeds the baseline WITHOUT firing
      // (`initialized` is still false here — it flips at the end of this callback), so
      // a join/reconnect into a match with an existing lastShot does NOT replay a shot
      // that already resolved; only genuinely newer seqs animate.
      const shot = doc.lastShot;
      if (shot) {
        if (!initialized) {
          lastSeenShotSeq = shot.seq;
        } else if (shot.seq !== lastSeenShotSeq) {
          lastSeenShotSeq = shot.seq;
          handlers.onShotResult(shot);
        }
      }

      // The SOLE turn/wind/HP/phase driver (replaces room.onStateChange). Runs AFTER
      // the shot dispatch above so a fresh shot has already armed `isAnimatingShot`;
      // this patch's reduced HP/position is then deferred to animation-land
      // (applyHpFromState / applySettleFromState). `syncFromState` still records the
      // authoritative HP into `syncedHp` regardless of the gate, so the land callback
      // reconciles to the correct absolute.
      handlers.onStateChange(convexDocToSyncedState(doc));

      // terrainVersion jump → getTerrain → decodeMaskRLE → onTerrainSnapshot (R7).
      const ver = doc.terrainVersion ?? 0;
      if (ver !== lastSeenTerrainVersion) {
        lastSeenTerrainVersion = ver;
        // A read-only secondary subscriber passes terrain:false to skip the pull —
        // the scene's primary subscription owns the single terrain fetch.
        if (opts?.terrain !== false) {
          terrainPull = terrainPull.then(async () => {
            try {
              const snap = await getTerrain(matchId);
              // A pull queued before teardown must not call into a torn-down scene.
              if (snap && !disposed) handlers.onTerrainSnapshot(snap);
            } catch (err) {
              console.error("[convex] getTerrain failed", err);
            }
          });
        }
      }

      // Terminal RESULTS → the match-end banner (winnerTeam -1 ⇒ draw). Fire once.
      if (doc.phase === "RESULTS" && !endedFired) {
        endedFired = true;
        handlers.onMatchEnded(doc.winnerTeam, doc.winnerTeam < 0);
      }

      // First snapshot fully processed — the shot baseline is now seeded.
      initialized = true;
    },
  );

  // Tear down BOTH the reactive subscription and the presence heartbeat together,
  // so presence is bound exactly to the live subscription lifecycle (D-05).
  return () => {
    disposed = true;
    stopPresence();
    unsub();
  };
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

/**
 * Telegraph the LOCAL active player's barrel aim to the opponent (Plan 10) —
 * cosmetic-only, fire-and-forget. Writes a SEPARATE throttled `matchAim` doc, NOT
 * the reactive `matches` doc (R4). The server resolves the caller seat + clamps +
 * delta-gates; the client throttles emission (≤5 Hz, delta-gated — see MatchScene).
 * Live-aim NEVER gates fire; dropping it has zero authority impact (D-01/D-02).
 */
export async function updateAim(
  matchId: string,
  angleDeg: number,
): Promise<void> {
  await getConvexClient().mutation(api.matchAim.updateAim, {
    matchId: matchId as unknown as never,
    angleDeg,
  });
}

/** The opponent-aim telegraph row `api.matchAim.get` returns (or null). */
export interface AimTelegraph {
  mobileId: string;
  angleDeg: number;
  seq: number;
}

/**
 * Subscribe to the live opponent-aim telegraph for `matchId` (Plan 10). Fires `cb`
 * on every `matchAim` patch with `{ mobileId, angleDeg, seq }` (or null until the
 * first aim). The scene feeds `angleDeg` into the opponent barrel's existing
 * `setBarrelAngleTarget` callsite (interpolated, cosmetic). Returns an unsubscribe
 * disposer. Reads only — never an authority source.
 */
export function subscribeAim(
  matchId: string,
  cb: (aim: AimTelegraph | null) => void,
): () => void {
  return getConvexClient().onUpdate(
    api.matchAim.get,
    { matchId: matchId as unknown as never },
    (raw) => cb(raw as AimTelegraph | null),
  );
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

// ─────────────────────── authed Meta-API wrappers (plan 09-11, [A1]) ───────────────────────
// The pure-Convex replacement for the REST `${SERVER_HTTP_URL}/internal/profile` +
// `/internal/loadout` reads/writes. Identity is derived server-side from the verified
// subject via the existing `client.setAuth('convex')` wiring (shell/auth.ts, plan 06) —
// NO Bearer header, NO SERVER_HTTP_URL. A caller can only ever read/write its OWN profile
// (the server keys off getUserIdentity().subject — D-08; no id crosses the wire).

/** The authed account row `api.accounts.getMyProfile` returns (or null). */
export interface MyProfile {
  display_name?: string;
  wins?: number;
  losses?: number;
}

/**
 * Read the caller's own profile (display name + W/L). Returns the row, or `null`
 * when the account has no row / no display name yet (drives the first-login handle
 * prompt). Replaces `GET /internal/profile` — the accountId is the verified subject.
 */
export async function getMyProfile(): Promise<MyProfile | null> {
  return (await getConvexClient().query(
    api.accounts.getMyProfile,
    {},
  )) as MyProfile | null;
}

/**
 * Write the caller's display handle to `accounts.display_name`. The accountId is
 * derived server-side from the verified subject, never the body (D-08). Throws on a
 * server rejection (empty/oversized handle) so the modal can surface the failure.
 * Replaces `POST /internal/profile`.
 */
export async function setMyDisplayName(displayName: string): Promise<void> {
  await getConvexClient().mutation(api.accounts.setMyDisplayName, {
    displayName,
  });
}

/** Read the caller's loadout defaults. Replaces `GET /internal/loadout/:accountId`. */
export async function getLoadout(): Promise<{ items: string[] }> {
  return (await getConvexClient().query(api.loadout.get, {})) as {
    items: string[];
  };
}
