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

/**
 * The authoritative server address. Build-time-injected via `VITE_SERVER_URL`
 * (Vite inlines `import.meta.env.VITE_*` at build — a runtime env is `undefined`
 * in a built static bundle), with a `ws://localhost:2567` fallback for local DEV
 * ONLY. A PRODUCTION build (`import.meta.env.PROD`) with a missing/empty
 * `VITE_SERVER_URL` throws loudly (no silent localhost in prod — review concern
 * #11): a misconfigured deploy fails fast rather than pointing the CDN bundle at
 * localhost. The deployed Vercel build sets this to the game server's `wss://`
 * host (Railway's `wss://<service>.up.railway.app`) — the value is set in Vercel
 * at deploy time (Plan 05). The deployed build ALSO sets `VITE_NETWORKED=1`
 * (review C2) so the bundle runs the real networked match (hotseat is the
 * documented-non-functional dev default); MatchScene already reads that flag —
 * the value is set in Vercel (Plan 05). `new Client(SERVER_URL)` handles `wss://`.
 */
function resolveServerUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL;
  if (import.meta.env.PROD && (envUrl === undefined || envUrl.trim() === "")) {
    throw new Error(
      "VITE_SERVER_URL is required for a production build (the deployed wss:// " +
        "game-server URL must be baked in at build time). Refusing to fall back " +
        "to ws://localhost:2567 in production. Set VITE_SERVER_URL in the Vercel " +
        "build env (Plan 05).",
    );
  }
  return envUrl ?? "ws://localhost:2567";
}

export const SERVER_URL = resolveServerUrl();

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
  /**
   * Optional: the server REJECTED a fire (wrong phase / not the active player /
   * unarmed item). The server sends `fireRejected { reason }` so the client can
   * surface a brief notice instead of silently doing nothing (Phase 8 follow-up).
   * Optional so the inert deep-link/reconnect handlers need not implement it.
   */
  onFireRejected?(reason: string): void;
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
 * The ROOM-SCOPED reconnection-token storage key (review MEDIUM — NOT a single
 * global `fwops:recoToken`, which would clobber the token if a tab were ever in
 * two rooms / reloaded across rooms). One token per room id, in sessionStorage so
 * it is tab-scoped and cleared when the tab closes.
 */
const recoKey = (roomId: string): string => `fwops:recoToken:${roomId}`;

/**
 * Wire ALL inbound listeners against the supplied handlers and RETURN a disposer
 * that removes EXACTLY the listeners it added. Shared by the fresh join, the
 * lobby join/create, and the reload reconnect so a resumed match registers the
 * IDENTICAL listeners — no logic, no mutation, just forwarding server
 * broadcasts/state to the scene.
 *
 * LISTENER LIFECYCLE (the leak fix): `@colyseus/sdk` APPENDS listeners —
 * `onMessage` (nanoevents `.on`) returns an unbind fn; `onStateChange`
 * (createSignal) APPENDS and is removed via `room.onStateChange.remove(cb)` with
 * the EXACT callback reference. The room OUTLIVES the scene (Blocker 3), so a
 * remount that re-registers WITHOUT removing the prior set stacks duplicate
 * handlers that fire into the destroyed prior scene. The returned disposer (run
 * on scene SHUTDOWN, and pre-emptively on re-attach via the WeakMap below)
 * guarantees no stacking.
 */
function registerHandlers(room: Room, handlers: NetHandlers): () => void {
  // NET-01: the authoritative shot outcome — the SOLE mutation trigger.
  const offShot = room.onMessage("shotResult", (result: ShotResult) =>
    handlers.onShotResult(result),
  );

  // NET-05: the RLE terrain snapshot (raw bytes), sent on join AND on reconnect.
  // Coerce the view to an owned Uint8Array, then decode it into a TerrainMask.
  const offTerrain = room.onMessage("terrainSnapshot", (payload: unknown) =>
    handlers.onTerrainSnapshot(decodeMaskRLE(toUint8Array(payload))),
  );

  // Team-or-draw banner. The server's draw broadcast is `{ winnerTeam: -1, draw: true }`.
  const offEnded = room.onMessage(
    "matchEnded",
    (payload: { winnerTeam: number; draw?: boolean }) =>
      handlers.onMatchEnded(payload.winnerTeam, payload.draw === true),
  );

  // fireRejected (Phase 8 follow-up): forwarded to the optional handler so the
  // scene can flash a brief notice; absent on inert handlers (a no-op then).
  const offFireRejected = room.onMessage(
    "fireRejected",
    (payload: { reason?: string }) =>
      handlers.onFireRejected?.(payload.reason ?? "rejected"),
  );

  // The full synced state on every patch — HP, wind, phase, activePlayer,
  // turnEndsAt, mobiles. syncFromState is the SOLE driver of turn/wind/HP/phase.
  // Hold the cb ref so the disposer can target it (createSignal.remove).
  const onState = (state: unknown): void => handlers.onStateChange(state);
  room.onStateChange(onState);

  return () => {
    offShot();
    offTerrain();
    offEnded();
    offFireRejected();
    room.onStateChange.remove(onState);
  };
}

/**
 * Persist the room's reconnection token ROOM-SCOPED so a full page reload of
 * `/play/:roomId` can call `reconnectToMatch(roomId)` (RECON-02). Stored on the
 * `leave`/match-end path it is cleared (see `clearReconnectToken`). The SDK
 * auto-reconnects TRANSIENT drops on its own; this token covers a hard reload.
 */
function persistReconnectToken(room: Room): () => void {
  try {
    sessionStorage.setItem(recoKey(room.roomId), room.reconnectionToken);
  } catch {
    // sessionStorage unavailable (private mode / SSR) — reconnect just won't persist.
  }
  // Clear the token on a clean leave / match end so a reload after the match does
  // NOT try to reconnect to a disposed room. Registered unconditionally (the
  // onLeave callback no-ops harmlessly if storage was unavailable). Hold the cb
  // ref so the disposer can remove it (createSignal appends — see registerHandlers).
  const onLeave = (): void => clearReconnectToken(room.roomId);
  room.onLeave(onLeave);
  return () => room.onLeave.remove(onLeave);
}

/** Clear a room's stored reconnection token (clean leave / match end). */
export function clearReconnectToken(roomId: string): void {
  try {
    sessionStorage.removeItem(recoKey(roomId));
  } catch {
    /* sessionStorage unavailable — nothing to clear. */
  }
}

/**
 * Module-level handoff of the ALREADY-JOINED MatchRoom from the shell to the
 * Phaser scene (Blocker 3). The shell's play page (plan 09) reads
 * `matchSession.current` — the SINGLE connection the room page joined — and calls
 * `provideMatchRoom(room)` BEFORE instantiating Phaser. `MatchScene.createNetworked`
 * then calls `takeProvidedMatchRoom()`: if a room is present it ADOPTS it (registers
 * its handlers on the SAME seat via `attachToMatch`) instead of opening a second
 * Colyseus `Client` through `connectToMatch`. This is the seam that closes the
 * duplicate-connection hazard — the room→play transition never opens a new seat.
 *
 * `take` is one-shot (clears the slot) so a later standalone `VITE_NETWORKED` boot
 * (no shell, no provided room) still falls through to `connectToMatch`.
 */
let providedRoom: Room | null = null;

/** Hand the already-joined MatchRoom to the next MatchScene boot (Blocker 3). */
export function provideMatchRoom(room: Room): void {
  providedRoom = room;
}

/** Take (and clear) the provided MatchRoom, or `null` if none was provided. */
export function takeProvidedMatchRoom(): Room | null {
  const room = providedRoom;
  providedRoom = null;
  return room;
}

/**
 * The shell's match-end hook (UI-SPEC #9 post-match banner). The SCENE is the
 * single owner of the room's `onMessage`/`onStateChange` listeners (Colyseus keys
 * those by type — a second `onMessage("matchEnded")` would CLOBBER the scene's).
 * So instead of the play page registering its own `matchEnded` listener (a
 * silent-overwrite bug), it registers THIS hook, which `MatchScene.onMatchEnded`
 * fans out to AFTER it deactivates the views. One listener, two consumers.
 */
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
 * The shell's fire-rejected hook (Phase 8 follow-up). Same fan-out pattern as the
 * match-end hook: the scene owns the single `fireRejected` onMessage listener and
 * forwards the reason here, and the play page renders a brief DOM toast.
 */
let shellFireRejectedHook: ((reason: string) => void) | null = null;

/** Register the shell-side fire-rejected callback (the play page's toast). */
export function setShellFireRejectedHook(
  cb: ((reason: string) => void) | null,
): void {
  shellFireRejectedHook = cb;
}

/** Invoked by the scene's onFireRejected to fan the rejection out to the shell. */
export function notifyShellFireRejected(reason: string): void {
  shellFireRejectedHook?.(reason);
}

/**
 * Per-room handler disposer registry (the leak fix). The MatchRoom OUTLIVES the
 * Phaser scene (Blocker 3), and `@colyseus/sdk` APPENDS listeners — so without
 * this, every scene mount / reconnect-remount / idempotent-rejoin stacks another
 * full handler set on the SAME surviving Room, and the stale sets fire into the
 * destroyed prior scene (the "background activity / screen flashes" + the
 * drawImage-null crash 3f0b340 only suppressed). Keyed by Room (one live Room per
 * session under matchSession); the entry holds the CURRENT registration's disposer.
 */
const handlerDisposers = new WeakMap<Room, () => void>();

/**
 * The single registration seam. Disposes ANY prior registration for this exact
 * room BEFORE re-registering (so a remount/rejoin never stacks), then stores the
 * fresh disposer. Used by attachToMatch (play-page handoff) AND every
 * connect/join/create/reconnect path so the dedupe is universal.
 */
function attachInternal(room: Room, handlers: NetHandlers): void {
  handlerDisposers.get(room)?.(); // dispose the prior registration, if any.
  const offHandlers = registerHandlers(room, handlers);
  const offToken = persistReconnectToken(room);
  handlerDisposers.set(room, () => {
    offHandlers();
    offToken();
  });
}

/**
 * Remove the listeners attachToMatch/connect/join/create/reconnect registered for
 * this room (NOT a match leave — listeners only; the connection survives). Called
 * on MatchScene SHUTDOWN so a torn-down scene's handlers never fire on its
 * destroyed Phaser objects. Idempotent (a missing entry is a no-op).
 */
export function disposeMatchHandlers(room: Room): void {
  handlerDisposers.get(room)?.();
  handlerDisposers.delete(room);
}

/**
 * Attach the scene's inbound listeners to an ALREADY-JOINED room (Blocker 3). Used
 * by the play-page handoff: the room was joined by the shell's matchSession (ONE
 * seat); this only registers the IDENTICAL listeners + refreshes the room-scoped
 * reconnection token. It does NOT construct a `Client` and does NOT join — so it
 * never opens a second seat. Returns the same room for convenience. Re-attaching
 * the same room disposes the prior registration first (attachInternal) — so the
 * matchSession idempotent-rejoin and a scene remount are both leak-free.
 */
export function attachToMatch(room: Room, handlers: NetHandlers): Room {
  attachInternal(room, handlers);
  return room;
}

/**
 * Connect to the dev server and join (or create) the "match" room as a guest
 * (no token this phase — the lobby-driven join + Clerk token is plan 06).
 * Registers all inbound listeners, persists the ROOM-SCOPED reconnection token,
 * and returns the live Room (the scene stores it + its sessionId for the input
 * gate, and sends aim/fire through it).
 */
export async function connectToMatch(handlers: NetHandlers): Promise<Room> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate("match", {});
  attachInternal(room, handlers);
  return room;
}

/**
 * Join a SPECIFIC existing "match" room by id, carrying the Clerk session token in
 * join OPTIONS (AUTH-03 — browsers cannot set WS headers, so the token rides the
 * join options the server's `onAuth` reads). Used by the lobby/room flow (plan 08)
 * and share-link deep-joins (LOBBY-05). Registers the IDENTICAL inbound listeners
 * and persists the ROOM-SCOPED reconnection token. Wraps the SDK client — the
 * shell's matchSession manager calls THIS, it never constructs its own Client.
 */
export async function joinRoomById(
  roomId: string,
  token: string,
  handlers: NetHandlers,
): Promise<Room> {
  const client = new Client(SERVER_URL);
  const room = await client.joinById(roomId, { token });
  attachInternal(room, handlers);
  return room;
}

/**
 * Create a NEW "match" room with the per-room options (mode/name) replacing the
 * old hardcoded `MATCH_CONFIG`, carrying the Clerk session token in join OPTIONS
 * (AUTH-03). Used by the lobby "CREATE ROOM" flow (plan 08). Registers listeners
 * and persists the reconnection token. Wraps the SDK client (no Client in the
 * shell's matchSession).
 */
export async function createMatch(
  options: { name: string; mode: string; token: string },
  handlers: NetHandlers,
): Promise<Room> {
  const client = new Client(SERVER_URL);
  const room = await client.create("match", options);
  attachInternal(room, handlers);
  return room;
}

/**
 * Resume a SPECIFIC match after a hard reload of `/play/:roomId` (RECON-02). Reads
 * the ROOM-SCOPED token from sessionStorage and calls `client.reconnect(token)` —
 * the reconnection token, NOT a fresh Clerk auth (onAuth/onJoin do NOT re-run, so
 * the 05-04 auth gate is satisfied by the original join). Returns the resumed Room,
 * or `null` if there is no stored token or the reconnect fails (window expired /
 * room disposed) — the caller then falls back to a fresh join.
 */
export async function reconnectToMatch(
  roomId: string,
  handlers: NetHandlers,
): Promise<Room | null> {
  let tok: string | null = null;
  try {
    tok = sessionStorage.getItem(recoKey(roomId));
  } catch {
    tok = null;
  }
  if (!tok) return null;

  const client = new Client(SERVER_URL);
  try {
    const room = await client.reconnect(tok);
    attachInternal(room, handlers); // refresh listeners + token for a subsequent reload.
    return room;
  } catch {
    clearReconnectToken(roomId); // stale/expired token — drop it.
    return null;
  }
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

/**
 * Training-only RESET (TR-9/TR-10): ask the server to rebuild the range. The
 * server's `onResetRange` rebuilds terrain/dummy/wind + the player's shot state
 * and re-sends the terrain snapshot. The message is INERT in non-training rooms —
 * the server gates it (`onResetRange` early-returns when `!isTraining`), so a
 * spoofed send in a real match does nothing (Plan 02 / threat T-08-08). The
 * message name `"resetRange"` and the empty `{}` payload MUST match the server's
 * `resetRangeSchema` + `messages.resetRange` (Plan 02).
 */
export function sendResetRange(room: Room): void {
  room.send("resetRange", {});
}
