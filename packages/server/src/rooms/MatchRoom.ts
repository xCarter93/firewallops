/**
 * MatchRoom — THE server authority (Phase 3, Plan 03).
 *
 * Owns and replaces the Plan 02 placeholder. This is the heart of Phase 3: the
 * server runs `@shared/sim` as the SOLE truth and broadcasts results clients
 * snap to. The client NEVER decides an outcome; the terrain mask NEVER enters
 * the synced schema.
 *
 * What this room owns:
 *   - the WAITING → TURN_START (observable dwell) → AIMING → RESOLVING → RESULTS
 *     state machine (NET-03), delegating transitions/win/forfeit to the PURE
 *     turn machine (turnMachine.ts) so the logic is unit-tested headlessly.
 *   - the active-player + phase gate (NET-02) + tightened Zod validation
 *     (NET-07) on every inbound message (finite bounds + itemId allow-list).
 *   - the `this.clock` turn timer with auto-forfeit (NET-04) — never a raw
 *     setTimeout/setInterval, so timers are cleaned on dispose and the match
 *     never stalls.
 *   - the in-memory TerrainMask + carve-replay, the onJoin RLE snapshot,
 *     team auto-balance, full-room lock + overflow reject (NET-05).
 *   - the shared barrel-tip launch origin (muzzleOffset — Authority Decision 4),
 *     server-authoritative SS-charge / Trojan arming (Authority Decision 5), and
 *     the schema-HP-is-the-absolute / shotResult.damage-is-animation-only
 *     contract (Agreed Concern #2).
 *
 * Colyseus 0.17 API discipline (verified against the installed .d.ts):
 *   - `extends Room<{ state: MatchState }>` (options-bag generic).
 *   - `this.state = new MatchState()` (NOT the deprecated setState).
 *   - `messages = { … }` with `validate(zodSchema, handler)`.
 *   - `client.sendBytes("terrainSnapshot", bytes)` for the raw RLE snapshot
 *     (client.send would msgpack-encode and corrupt the bytes).
 *   - `this.clock.setTimeout(...)` returning a `Delayed` cleared via `.clear()`.
 *   - `onLeave(client, code?: number)` (NOT consented: boolean).
 */
import { Room, Client, validate, updateLobby } from "@colyseus/core";
import { TerrainMask, encodeMaskRLE, muzzleOffset, LOADOUT, clampAbsoluteAngle, aimWindowMid } from "@shared/sim";
import type { ProjectileDef, ShotInput } from "@shared/sim";
import { MatchState, Mobile } from "./schema/MatchState.js";
import {
  TURN_MS,
  TURN_START_DWELL_MS,
  FORFEIT_DELAY,
  WIND_MIN,
  WIND_MAX,
  GRAVITY,
  SS_HITS_TO_ARM,
  teamSizeForMode,
  type MatchMode,
  resolveDwellMs,
} from "../config.js";
import { MAP, spawnLayout, surfaceY, settledY } from "../match/world.js";
import { runServerShot, type ServerMech } from "../match/resolve.js";
import {
  advanceTurn,
  checkWinTeam,
  assignTeam,
  seatsFull,
  shouldAutoStart,
  timeoutOutcome,
  forfeitOutcome,
  canFire,
  shouldResolveFire,
  type TurnMobile,
} from "../match/turnMachine.js";
import {
  fireSchema,
  aimSchema,
  selectItemSchema,
  readySchema,
  type FireMessage,
  type AimMessage,
  type SelectItemMessage,
  type ReadyMessage,
} from "../match/messageSchemas.js";
import { recordMatchResult } from "../meta/results.js";
import { verifyClerk } from "../auth/clerk.js";
import { getConvex, api } from "../meta/convexClient.js";
import {
  TokenBucket,
  withinSizeLimit,
  MAX_MESSAGE_BYTES,
  AIM_BUCKET_CAPACITY,
  AIM_BUCKET_REFILL_PER_SEC,
  ITEM_BUCKET_CAPACITY,
  ITEM_BUCKET_REFILL_PER_SEC,
} from "../ratelimit/tokenBucket.js";

export class MatchRoom extends Room<{ state: MatchState }> {
  /** The authoritative collision mask — room memory ONLY, never a @type() field. */
  private terrain!: TerrainMask;
  /**
   * The active turn timer handle (NET-04) — cleared on a real fire / reschedule.
   * Typed off `this.clock.setTimeout`'s return (`Delayed`) so we do not take a
   * direct dependency on the transitive `@colyseus/timer` package path.
   */
  private turnTimer?: ReturnType<MatchRoom["clock"]["setTimeout"]>;

  /**
   * Graceful-drain flag (review H2). Set true by `onBeforeShutdown` on a
   * deploy/restart so the shutdown is observable (the broadcast notifies clients;
   * the flag records the state). Reconnection is Phase 5 — this is the Phase-4
   * best-effort drain so a deploy does not SILENTLY kill a live match.
   */
  draining = false;

  /**
   * Per-room mode + derived team size (LOBBY-03). Mode is a CREATE OPTION (no
   * longer the global `MATCH_CONFIG` constant); `teamSize` = `teamSizeForMode`,
   * so total seats = `teamSize * 2` and `this.maxClients` is set to that in
   * onCreate. Defaults cover a create with no options (local two-tab 1v1).
   */
  private mode: MatchMode = "1v1";
  private teamSize = 1;
  // NOTE: distinct from the base Room.roomName (the registered handler id "match").
  // This is the human-facing lobby label; do NOT name it `roomName` — shadowing the
  // base field as private breaks updateLobby(this)'s `Room` structural type.
  private lobbyName = "ROOM";

  /**
   * PRIVATE server-side identity binding (Blocker 1): sessionId → verified Clerk
   * accountId (the `sub`). Used ONLY for server-side W/L attribution at match
   * end. NEVER a synced `@type()` field, NEVER broadcast — the public handle is
   * the synced `Mobile.displayName`, not this.
   */
  private accountIds = new Map<string, string>();

  /**
   * H4 per-sessionId rate limiters — SEPARATE buckets for the high-frequency
   * `aim` stream and the low-frequency `selectItem` (review LOW). Lazily created
   * per session, fed by `this.clock.currentTime` (the room clock, never an
   * ambient wall clock), and combined
   * with a per-message size cap. Over-rate / oversize messages are DROPPED and
   * counted in `rejections`.
   */
  private aimBuckets = new Map<string, TokenBucket>();
  private itemBuckets = new Map<string, TokenBucket>();
  private rejections = 0;

  /**
   * Inbound message map (NET-02 gate + NET-07 validation). Each handler is
   * wrapped in the Colyseus `validate(schema, handler)` helper, so a payload
   * failing the tightened Zod schema (power > 100, NaN, unknown itemId,
   * malformed) is dropped BEFORE the handler runs. The handlers then apply the
   * active-player + phase gate before any state mutation.
   *
   * Arrow functions bind `this` to the constructed room instance.
   */
  messages = {
    fire: validate(fireSchema, (client: Client, payload: FireMessage) =>
      this.onFire(client, payload),
    ),
    aim: validate(aimSchema, (client: Client, payload: AimMessage) =>
      this.onAim(client, payload),
    ),
    selectItem: validate(
      selectItemSchema,
      (client: Client, payload: SelectItemMessage) =>
        this.onSelectItem(client, payload),
    ),
    // Lobby ready toggle (LOBBY-04). The intent is the message name; the empty
    // schema rejects any unexpected payload. Auto-start (no manual master Start)
    // is gated on full && all-ready.
    ready: validate(readySchema, (client: Client, _payload: ReadyMessage) =>
      this.setReady(client.sessionId, true),
    ),
    unready: validate(readySchema, (client: Client, _payload: ReadyMessage) =>
      this.setReady(client.sessionId, false),
    ),
  };

  async onCreate(options?: { name?: string; mode?: MatchMode }): Promise<void> {
    this.state = new MatchState();
    // Authoritative mask in room memory ONLY (Pitfall 4 / NET-05). Built from
    // the server MAP — byte-identical to the client world.ts so carves replay
    // identically on every client.
    this.terrain = TerrainMask.fromMap(MAP);

    // Per-room mode (LOBBY-03). Mode is a CREATE OPTION; teamSize is derived and
    // total seats = teamSize * 2. maxClients makes Colyseus itself cap seats —
    // the onJoin overflow guard is the explicit reject on top of it.
    this.mode = options?.mode ?? "1v1";
    this.teamSize = teamSizeForMode(this.mode);
    this.lobbyName = options?.name ?? "ROOM";
    this.maxClients = this.teamSize * 2;

    // Publish initial joinable metadata so the live lobby list shows this open
    // room (LOBBY-01/02). CRITICAL (Pitfall 1): setMetadata alone does NOT notify
    // the lobby — always follow it with updateLobby(this).
    await this.setMetadata({
      name: this.lobbyName,
      mode: this.mode,
      map: "default",
      players: 0,
      maxPlayers: this.teamSize * 2,
      readyCount: 0,
      locked: false,
      phase: "WAITING",
    });
    updateLobby(this);
  }

  /**
   * Re-publish the current joinable metadata to the lobby (LOBBY-01/02). Called
   * after EVERY seat / ready / lock / phase change so the live list stays
   * accurate. `locked` is true once the match has started (phase past WAITING) OR
   * the room is full — a full-but-not-ready room is removed from matchmaking.
   *
   * Pitfall 1: setMetadata alone does NOT notify the lobby — always followed by
   * updateLobby(this).
   */
  private async refreshListing(): Promise<void> {
    let readyCount = 0;
    this.state.mobiles.forEach((m) => {
      if (m.ready) readyCount++;
    });
    const players = this.state.mobiles.size;
    const locked =
      this.state.phase !== "WAITING" || seatsFull(players, this.teamSize);
    await this.setMetadata({
      name: this.lobbyName,
      mode: this.mode,
      map: "default",
      players,
      maxPlayers: this.teamSize * 2,
      readyCount,
      locked,
      phase: this.state.phase,
    });
    updateLobby(this);
  }

  /**
   * Real identity handshake (Plan 04, AUTH-03 + Blocker 1). The Clerk token
   * arrives in the JOIN OPTIONS (browsers cannot set WS request headers, so the
   * token is NEVER read from headers), is verified via the SHARED `verifyClerk`
   * seam (one token, two consumers — same wrapper as the Meta-API routes), and
   * resolves to the verified `sub` as the accountId. The PUBLIC display handle is
   * loaded server-side from `accounts.display_name`. Both ride on `client.auth`
   * so onJoin can bind the PRIVATE accountId and sync the PUBLIC displayName.
   *
   * On a missing or invalid token this throws — Colyseus rejects the join
   * (T-05-AUTH-04: no impersonation, accountId = verified sub, never client
   * supplied).
   */
  async onAuth(
    _client: Client,
    options: { token?: string } | undefined,
    _context: unknown,
  ): Promise<{ accountId: string; displayName: string }> {
    if (!options?.token) throw new Error("auth required");
    const { accountId } = await verifyClerk(options.token);
    // Public handle = accounts.display_name (Blocker 1). Falls back to a generic
    // label if the account row has no name yet.
    const row = await getConvex().query(api.accounts.getByAuthUserId, {
      authUserId: accountId,
    });
    const displayName = row?.display_name ?? "AGENT";
    return { accountId, displayName };
  }

  /**
   * NET-05 + LOBBY-03/04: terrain snapshot + auto-balance + lock-on-full +
   * identity bind. Overflow joiners are rejected (Agreed Concern #3 / Authority
   * Decision 3); maxClients is the primary cap (set in onCreate), this guard is
   * the explicit deterministic reject. NOTE: the match no longer auto-starts on
   * full — it waits for full && all-ready (see setReady).
   */
  onJoin(client: Client): void {
    // Overflow guard FIRST — a late join into a FULL room is rejected with a
    // logged normal-close leave, before any seat is created, regardless of ready
    // state (a full-but-not-ready room admits NO further clients).
    if (seatsFull(this.state.mobiles.size, this.teamSize)) {
      console.warn(
        `[match] full (${this.teamSize * 2} seats) — rejecting ${client.sessionId}`,
      );
      client.leave(1000);
      return;
    }

    const joinOrder = this.state.mobiles.size;
    const team = assignTeam(joinOrder, this.teamSize);

    // Seat from the server spawn layout (mask surface Y). The layout fills in
    // JOIN order A,B,A,B… so layout[joinOrder] aligns with assignTeam(joinOrder).
    const seats = spawnLayout(this.terrain, this.teamSize);
    const seat = seats[joinOrder];

    const mobile = new Mobile();
    mobile.sessionId = client.sessionId;
    mobile.team = team;
    mobile.facing = team === 0 ? 1 : -1; // A faces right, B faces left
    mobile.x = seat.x;
    mobile.y = seat.y;
    mobile.hp = 100;
    // PUBLIC handle (Blocker 1): the name shown to peers, from accounts.display_name.
    mobile.displayName = client.auth.displayName ?? "AGENT";
    this.state.mobiles.set(client.sessionId, mobile);

    // PRIVATE identity bind (Blocker 1): sessionId → verified Clerk accountId.
    // Server-side ONLY — never synced, never broadcast. Used for W/L attribution.
    this.accountIds.set(client.sessionId, client.auth.accountId);

    // One-time RLE terrain snapshot as RAW BYTES (NET-05). sendBytes keeps the
    // bytes intact; client.send would msgpack-encode and corrupt them.
    client.sendBytes("terrainSnapshot", encodeMaskRLE(this.terrain));

    // LOCK ON FULL (LOBBY-03): a full room is removed from matchmaking the moment
    // every seat is filled — even before it is all-ready. The match START is
    // gated separately on full && all-ready (setReady), NOT here.
    if (seatsFull(this.state.mobiles.size, this.teamSize)) {
      void this.lock();
    }

    // Re-publish the live metadata (players/readyCount/locked) to the lobby.
    void this.refreshListing();
  }

  /**
   * Lobby ready toggle (LOBBY-04). Acts ONLY in WAITING; flips the mobile's
   * synced `ready`, re-publishes the listing, then auto-starts when the room is
   * full && every mobile is ready — there is NO manual master Start. The room is
   * ALREADY locked on full (onJoin), so this never re-locks; it only starts.
   */
  private setReady(sessionId: string, ready: boolean): void {
    if (this.state.phase !== "WAITING") return;
    const mobile = this.state.mobiles.get(sessionId);
    if (!mobile) return;
    mobile.ready = ready;
    void this.refreshListing();

    const flags: boolean[] = [];
    this.state.mobiles.forEach((m) => flags.push(m.ready));
    if (shouldAutoStart(this.state.mobiles.size, this.teamSize, flags)) {
      this.startTurn();
    }
  }

  /**
   * Transport drop (RECON-01) — a client lost its connection (NOT a consented
   * leave). Grant the 30s reconnection window: flip the synced `connected=false`
   * so peers render the disconnect, re-publish the listing, then AWAIT
   * `allowReconnection(client, 30)`.
   *
   * Pitfall 2 — cleanup belongs ONLY in the reject branch, NEVER before/around
   * the await: if the await RESOLVES the client returned (onReconnect resends the
   * snapshot + flips connected back to true); if it REJECTS the window expired and
   * we run the single idempotent removeAndForfeit. The connection-independent turn
   * timer (NET-04) keeps the match advancing while the player is dropped (RECON-03),
   * so a never-returning drop self-resolves at the window edge with no stall.
   */
  async onDrop(client: Client, _code?: number): Promise<void> {
    console.log(
      `[match] onDrop ${client.sessionId} phase=${this.state.phase} code=${String(_code)} — opening 30s reconnection window`,
    );
    const m = this.state.mobiles.get(client.sessionId);
    if (m) m.connected = false;
    void this.refreshListing();
    try {
      // RECON-01: 30s window (MUST pass the count — never the deprecated no-arg form).
      await this.allowReconnection(client, 30);
      // Resolved → the client reconnected; onReconnect handled the snapshot resend.
      console.log(`[match] reconnected ${client.sessionId}`);
    } catch {
      // Window expired → the single idempotent removal path (Pitfall 2).
      console.log(
        `[match] reconnection window expired ${client.sessionId} → removeAndForfeit`,
      );
      this.removeAndForfeit(client.sessionId);
    }
  }

  /**
   * Reconnection (RECON-02). The client returned within the 30s window via the
   * reconnection token (NOT a fresh Clerk auth — onAuth/onJoin do NOT re-run, so
   * the auth gate from 05-04 is satisfied by the original join). Flip the synced
   * `connected=true`, RESEND the versioned RLE terrain snapshot as RAW BYTES (the
   * room's existing sendBytes path — NOT client.send/msgpack), and re-publish the
   * listing. HP / turn / wind / phase re-sync automatically via the synced state.
   */
  onReconnect(client: Client): void {
    const m = this.state.mobiles.get(client.sessionId);
    if (m) m.connected = true;
    // Versioned RLE snapshot resend (plan 01 format) — raw bytes, same path as onJoin.
    client.sendBytes("terrainSnapshot", encodeMaskRLE(this.terrain));
    void this.refreshListing();
  }

  /**
   * Consented quit OR post-window expiry (H1). Both funnel through the SINGLE
   * idempotent removeAndForfeit — the fix for the old log-only onLeave that leaked
   * ghost players. (A transient drop instead routes through onDrop's
   * allowReconnection window; only a CONSENTED leave reaches here directly.)
   */
  onLeave(client: Client, _code?: number): void {
    this.removeAndForfeit(client.sessionId);
  }

  /**
   * The SINGLE idempotent removal path (RECON-04 / H1 / Blocker 5 + Blocker 2).
   * Called from BOTH the onDrop reject branch AND onLeave. Idempotent via the
   * `if (!m) return` guard — a second call on an already-removed sessionId is a
   * no-op (no ghost, no double abandon-loss, no double team-elim).
   *
   * STRIPS THE LEAVER FROM EVERY MATCH STRUCTURE (Blocker 5): the synced mobile
   * (which also removes it from turnView()/advanceTurn/the delay queue, since the
   * delay state lives in the per-mobile accumulatedDelay), BOTH H4 rate buckets,
   * the private identity map, and the active-player slot + turn timer when the
   * leaver was the active player.
   *
   * DOES NOT UNLOCK (Blocker 5): an in-progress room stays LOCKED. Freeing a seat
   * means "no leak", NEVER "admit a replacement".
   *
   * RECORDS THE ABANDON (Blocker 2): an explicit `abandon_loss` with a GRANULAR
   * `${roomId}:abandon:${accountId}` id (distinct from endMatch's
   * `${roomId}:final:${accountId}`), so the abandon write and the final write
   * never collide and a retry is a Convex no-op.
   */
  private removeAndForfeit(sessionId: string): void {
    const m = this.state.mobiles.get(sessionId);
    if (!m) return; // idempotency guard (H1) — already removed.

    const accountId = this.accountIds.get(sessionId);
    const wasInProgress =
      this.state.phase !== "RESULTS" && this.state.phase !== "WAITING";
    const wasActive = sessionId === this.state.activePlayer;

    // Decide team-elimination with the PURE helper BEFORE mutating state.
    const { outcome } = forfeitOutcome(this.turnView(), sessionId);

    // STRIP FROM ALL MATCH STRUCTURES (Blocker 5).
    this.state.mobiles.delete(sessionId);
    this.aimBuckets.delete(sessionId);
    this.itemBuckets.delete(sessionId);
    this.accountIds.delete(sessionId);
    if (wasActive) {
      // Clear the stale active slot + its timer so it never points at a removed mobile.
      this.turnTimer?.clear();
      this.state.activePlayer = "";
    }

    // DO NOT UNLOCK (Blocker 5) — the in-progress room stays locked; only republish.
    void this.refreshListing();

    // RECORD THE ABANDON-LOSS (Blocker 2) — only for an in-progress match with a
    // bound accountId. Explicit `abandon_loss` + granular `${roomId}:abandon:${accountId}`.
    if (wasInProgress && accountId) {
      recordMatchResult({
        winnerTeam: outcome.kind === "winner" ? outcome.team : -1,
        resultId: `${this.roomId}:abandon:${accountId}`,
        players: [
          {
            accountId,
            outcome: "abandon_loss",
            resultId: `${this.roomId}:abandon:${accountId}`,
          },
        ],
      });
    }

    // APPLY THE TEAM-ELIM / TURN-ADVANCE OUTCOME. Every branch is safe to call
    // twice (the `if (!m) return` guard above makes the whole method idempotent).
    if (outcome.kind === "winner") {
      this.endMatch(outcome.team);
    } else if (outcome.kind === "draw") {
      this.endMatchDraw();
    } else if (wasActive) {
      // continue + the leaver was the active player → advance the turn. The timer
      // was cleared above; startTurn picks the next active off the smaller turnView().
      this.startTurn();
    }
  }

  // ───────────────────────────── message handlers ─────────────────────────────

  private onFire(client: Client, payload: FireMessage): void {
    const mobile = this.state.mobiles.get(client.sessionId);
    if (!mobile) return;

    // SINGLE fire-acceptance decision (NET-02 gate + Trojan-arming gate). A
    // dropped fire never reaches the resolver and never mutates state. The
    // gate-before-logic integration tests assert against this same predicate.
    const ok = shouldResolveFire({
      phase: this.state.phase,
      senderId: client.sessionId,
      activePlayer: this.state.activePlayer,
      itemId: payload.itemId,
      ssHitCharge: mobile.ssHitCharge,
      ssHitsToArm: SS_HITS_TO_ARM,
    });
    if (!ok) return;

    // The committed shot uses the payload's item + angle/power.
    mobile.selectedItemId = payload.itemId;
    mobile.angleDeg = payload.angleDeg;
    mobile.power = payload.power;
    this.resolveActiveShot(mobile, payload.angleDeg, payload.power, payload.itemId);
  }

  /**
   * H4 per-sessionId rate + size guard (T-05-H4-02). Lazily creates the bucket
   * for this session in the given map, drops the message if the serialized
   * (already-decoded) payload exceeds MAX_MESSAGE_BYTES or the bucket is empty,
   * and counts every drop in `rejections`. This is an APP-LEVEL abuse guard on
   * the decoded handler payload — NOT a transport byte ceiling. The bucket is fed
   * by `this.clock.currentTime` (the deterministic room clock), never an ambient
   * wall clock.
   */
  private allow(
    map: Map<string, TokenBucket>,
    sessionId: string,
    raw: unknown,
    cap: number,
    refill: number,
  ): boolean {
    let bucket = map.get(sessionId);
    if (!bucket) {
      bucket = new TokenBucket(cap, refill, this.clock.currentTime);
      map.set(sessionId, bucket);
    }
    const size = JSON.stringify(raw ?? {}).length;
    if (!withinSizeLimit(size, MAX_MESSAGE_BYTES)) {
      this.rejections++;
      return false;
    }
    if (!bucket.take(this.clock.currentTime)) {
      this.rejections++;
      return false;
    }
    return true;
  }

  private onAim(client: Client, payload: AimMessage): void {
    // H4 (review LOW): high-frequency aim bucket + size cap; drop over-rate/oversize.
    const aimOk = this.allow(this.aimBuckets, client.sessionId, payload, AIM_BUCKET_CAPACITY, AIM_BUCKET_REFILL_PER_SEC);
    if (!aimOk) return;
    if (!canFire(this.state.phase, client.sessionId, this.state.activePlayer)) {
      return;
    }
    const mobile = this.state.mobiles.get(client.sessionId);
    if (!mobile) return;

    // Stream the aim (drives the spectator barrel render AND the timeout
    // auto-fire). powerLocked is set ONLY on an explicit commit/release flag
    // (Agreed Concern #6) — a mid-charge throttled aim leaves it false, so a
    // timeout on a partial charge SKIPS rather than auto-firing a half shot.
    //
    // AIM-01: clamp the streamed angle to the window BEFORE the write so the
    // spectator barrel render AND the locked-aim value the timeout auto-fires are
    // ALREADY in-window. Facing comes from server state, not client input.
    const facing: 1 | -1 = mobile.facing === -1 ? -1 : 1;
    mobile.angleDeg = clampAbsoluteAngle(payload.angleDeg, facing);
    mobile.power = payload.power;
    mobile.powerLocked = payload.committed === true;
  }

  private onSelectItem(client: Client, payload: SelectItemMessage): void {
    // H4 (review LOW): low-frequency item bucket + size cap; drop over-rate/oversize.
    const itemOk = this.allow(this.itemBuckets, client.sessionId, payload, ITEM_BUCKET_CAPACITY, ITEM_BUCKET_REFILL_PER_SEC);
    if (!itemOk) return;
    if (!canFire(this.state.phase, client.sessionId, this.state.activePlayer)) {
      return;
    }
    const mobile = this.state.mobiles.get(client.sessionId);
    if (!mobile) return;

    // Same arming gate: selecting the Trojan before it is earned is rejected.
    if (payload.itemId === "trojan" && mobile.ssHitCharge < SS_HITS_TO_ARM) {
      return;
    }
    mobile.selectedItemId = payload.itemId;
  }

  // ───────────────────────────── turn machine ─────────────────────────────

  /** Snapshot the synced mobiles as the pure turn-machine view. */
  private turnView(): TurnMobile[] {
    const view: TurnMobile[] = [];
    this.state.mobiles.forEach((m) => {
      view.push({
        sessionId: m.sessionId,
        team: m.team,
        hp: m.hp,
        accumulatedDelay: m.accumulatedDelay,
        powerLocked: m.powerLocked,
      });
    });
    return view;
  }

  /**
   * Begin a turn (NET-03). Sets the OBSERVABLE TURN_START phase, picks the next
   * active player off the delay queue, rolls wind, and resets the active
   * mobile's commit/charge. A SHORT dwell holds TURN_START as its own synced
   * patch so Colyseus batching does not collapse it into AIMING within one tick
   * (success criterion #2 names TURN_START as observable).
   */
  private startTurn(): void {
    this.state.phase = "TURN_START";
    this.state.activePlayer = advanceTurn(this.turnView());
    this.rollWind();

    const active = this.state.mobiles.get(this.state.activePlayer);
    if (active) {
      active.powerLocked = false;
      active.power = 0;
      // AIM-01: open the turn CENTERED in-window. Seed the angle to the window
      // midpoint in ABSOLUTE terms for this mobile's facing, so a turn that
      // times out before any aim auto-fires from the centered default — never a
      // stale out-of-window value. clampAbsoluteAngle maps the relative midpoint
      // through facing exactly like the shot seam.
      active.angleDeg = clampAbsoluteAngle(
        aimWindowMid(),
        active.facing === -1 ? -1 : 1,
      );
    }

    // Dwell on TURN_START so it is a distinct patch, then enter AIMING.
    this.clock.setTimeout(() => this.enterAiming(), TURN_START_DWELL_MS);
  }

  private enterAiming(): void {
    this.state.phase = "AIMING";
    this.state.turnEndsAt = this.clock.currentTime + TURN_MS;
    this.turnTimer?.clear();
    this.turnTimer = this.clock.setTimeout(() => this.onTimeout(), TURN_MS);
  }

  /** Roll wind into [WIND_MIN, WIND_MAX] (mirrors MatchController.rollWind). */
  private rollWind(rng: () => number = Math.random): void {
    this.state.wind = WIND_MIN + rng() * (WIND_MAX - WIND_MIN);
  }

  /**
   * Resolve a fired shot (NET-01). Cancels the turn timer, runs `@shared/sim`
   * via runServerShot from the SHARED muzzle-tip launch origin, writes the
   * authoritative absolute HP back into the schema, ticks SS-charge, accumulates
   * the def's turnDelay, broadcasts the shotResult (animation-only damage +
   * carves), then resolves the win / draw / next turn.
   */
  private resolveActiveShot(
    active: Mobile,
    angleDeg: number,
    power: number,
    itemId: string,
  ): void {
    this.turnTimer?.clear();
    this.state.phase = "RESOLVING";

    // AIM-01 AUTHORITATIVE clamp at the SINGLE shot-resolution seam. EVERY shot
    // path converges here — onFire's direct call AND onTimeout's auto-fire of a
    // (possibly stale) streamed angle — so NO path can bypass the window. Re-derive
    // the authoritative angle from the FIRING mobile's facing (server state, never
    // client input) and clamp into the per-mech window. A hacked client firing
    // straight across at abs 5°, or a timeout auto-fire of a stale out-of-window
    // value, is corrected to the window bound BEFORE muzzleOffset / runServerShot.
    const facing: 1 | -1 = active.facing === -1 ? -1 : 1;
    const clampedAngle = clampAbsoluteAngle(angleDeg, facing);
    active.angleDeg = clampedAngle;

    const def: ProjectileDef = LOADOUT[itemId as keyof typeof LOADOUT];

    // Map synced mobiles → plain ServerMech[] for the pure resolver.
    const mechs: ServerMech[] = [];
    this.state.mobiles.forEach((m) => {
      mechs.push({ id: m.sessionId, x: m.x, y: m.y, hp: m.hp });
    });

    // Launch origin = the SHARED barrel tip (Authority Decision 4), NOT the raw
    // mobile center — so the authoritative arc matches the client aim preview.
    const origin = muzzleOffset(active.x, active.y, clampedAngle);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg: clampedAngle,
      power,
      wind: this.state.wind,
      gravity: GRAVITY,
      projectile: def,
    };

    const result = runServerShot(aim, def, this.terrain, mechs);

    // HP contract (Agreed Concern #2): the schema HP is the authoritative
    // ABSOLUTE — copy the resolved hp back. The broadcast shotResult carries
    // `damage` (a delta) + `carves` for ANIMATION ONLY; the client reconciles
    // to the schema hp after the animation, never double-applying the delta.
    for (const m of mechs) {
      const mob = this.state.mobiles.get(m.id);
      if (mob) mob.hp = m.hp;
    }

    // Settle every mobile onto the POST-CARVE surface — a mobile floated when
    // the ground beneath it was blown away. Authoritative + synced (schema y):
    // the client reconciles each mobile's y on animation-land, exactly like HP.
    // Drop-only, NO fall damage (PROJECT.md out-of-scope), and the SAME raw
    // surfaceY seating spawnLayout uses so spawn and settle never disagree.
    this.state.mobiles.forEach((m) => {
      m.y = settledY(m.y, surfaceY(this.terrain, Math.round(m.x)));
    });

    // SS-charge tick (Authority Decision 5): any landed damage counts as one
    // hit (capped); firing the Trojan consumes the charge.
    if (result.damage.length > 0) {
      active.ssHitCharge = Math.min(SS_HITS_TO_ARM, active.ssHitCharge + 1);
    }
    if (def.id === "trojan") {
      active.ssHitCharge = 0;
    }

    // Delay queue: firing accumulates the def's tempo cost.
    active.accumulatedDelay += def.turnDelay;

    // Authoritative outcome broadcast (NET-01).
    this.broadcast("shotResult", result);

    // Hold RESOLVING for the shot's flight + a post-impact settle beat before
    // advancing the turn / ending the match — so the turn no longer flips the
    // instant the shot is fired (the turn timer is already cleared above). The
    // dwell mirrors the client's flight timing from the SAME path length.
    this.clock.setTimeout(
      () => this.afterResolve(),
      resolveDwellMs(result.path.length),
    );
  }

  /**
   * Post-RESOLVING transition (NET-03), scheduled by resolveActiveShot after the
   * client-animation dwell: resolve win / draw / next turn — the result is NEVER
   * left undefined. Split out of resolveActiveShot so the turn advance waits for
   * the shot to land instead of firing synchronously in the same tick as the
   * shotResult broadcast.
   */
  private afterResolve(): void {
    const outcome = checkWinTeam(this.turnView());
    if (outcome.kind === "winner") {
      this.endMatch(outcome.team);
    } else if (outcome.kind === "draw") {
      this.endMatchDraw();
    } else {
      this.startTurn();
    }
  }

  /**
   * Turn-timeout (NET-04): auto-fire the LOCKED aim, or skip + apply
   * FORFEIT_DELAY. Either branch advances — the match never stalls.
   */
  private onTimeout(): void {
    const active = this.state.mobiles.get(this.state.activePlayer);
    if (!active) {
      // Defensive: no active mobile (e.g. it left) — just advance.
      this.startTurn();
      return;
    }

    const outcome = timeoutOutcome({
      sessionId: active.sessionId,
      team: active.team,
      hp: active.hp,
      accumulatedDelay: active.accumulatedDelay,
      powerLocked: active.powerLocked,
    });

    if (outcome.kind === "auto-fire") {
      // Fire the last streamed aim (the locked shot) via the same resolve path.
      this.resolveActiveShot(
        active,
        active.angleDeg,
        active.power,
        active.selectedItemId,
      );
    } else {
      // Skip: yield the turn by penalizing the delay accumulator.
      active.accumulatedDelay += FORFEIT_DELAY;
      this.startTurn();
    }
  }

  /**
   * Build the per-player EXPLICIT-OUTCOME results payload (AUTH-05, Blocker 2).
   * Each seated mobile with a bound accountId gets an explicit win/loss/draw —
   * NEVER a boolean `won`, so a draw is `draw` (neither), never a mis-encoded
   * loss. Each player carries a GRANULAR `${roomId}:final:${accountId}` id (so
   * Convex dedups per player+event), plus the top-level EVENT id `${roomId}:final`.
   *
   * `winnerTeam === -1` is the draw sentinel. Plan 05's abandon-loss path uses
   * the SEPARATE `${roomId}:abandon:${accountId}` id, so the two never collide.
   */
  private finalResultsPayload(winnerTeam: number): {
    winnerTeam: number;
    resultId: string;
    players: { accountId: string; outcome: "win" | "loss" | "draw"; resultId: string }[];
  } {
    const players: {
      accountId: string;
      outcome: "win" | "loss" | "draw";
      resultId: string;
    }[] = [];
    this.state.mobiles.forEach((m) => {
      const accountId = this.accountIds.get(m.sessionId);
      if (!accountId) return;
      const outcome: "win" | "loss" | "draw" =
        winnerTeam === -1 ? "draw" : m.team === winnerTeam ? "win" : "loss";
      players.push({
        accountId,
        outcome,
        resultId: `${this.roomId}:final:${accountId}`,
      });
    });
    return { winnerTeam, resultId: `${this.roomId}:final`, players };
  }

  private endMatch(winnerTeam: number): void {
    this.state.phase = "RESULTS";
    this.state.winnerTeam = winnerTeam;
    this.broadcast("matchEnded", { winnerTeam });
    // In-process authoritative write (review H7 preferred path) with per-player
    // EXPLICIT outcomes + granular per-player+event ids (Blocker 2) so a re-record
    // is a no-op and never collides with plan 05's abandon write.
    recordMatchResult(this.finalResultsPayload(winnerTeam));
    void this.refreshListing();
  }

  /** Simultaneous-wipe draw (Codex MEDIUM) — winnerTeam -1 sentinel, never silent. */
  private endMatchDraw(): void {
    this.state.phase = "RESULTS";
    this.state.winnerTeam = -1;
    this.broadcast("matchEnded", { winnerTeam: -1, draw: true });
    recordMatchResult(this.finalResultsPayload(-1));
    void this.refreshListing();
  }

  /**
   * Graceful-drain hook (review H2) — Colyseus calls this when the server is
   * shutting down for a deploy/restart (`gracefullyShutdown: true` is set in
   * index.ts). It must NOT silently kill a live match. It:
   *   - STOPS NEW MATCHMAKING: `this.lock()` removes the room from matchmaking
   *     availability so no new client is placed into it while it drains.
   *   - SIGNALS THE DRAIN: a `serverDraining` broadcast notifies in-flight
   *     clients the server is going down, and the `draining` flag records it —
   *     the shutdown is observable, not a silent kill.
   *   - DRAINS BEST-EFFORT: it does NOT abruptly dispose an in-progress match.
   *     The default Colyseus graceful-shutdown sequence plus the Railway
   *     `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`/`OVERLAP_SECONDS` window (set in
   *     Plan 04/05) gives the in-flight match time to wind down. True
   *     reconnection is Phase 5 (H1); this is the Phase-4 best-effort drain.
   *
   * Returning a promise lets Colyseus await the hook; we keep the awaited work
   * bounded (a synchronous lock + broadcast) — the real time budget is the
   * Railway draining-seconds env, not a server-side sleep.
   */
  async onBeforeShutdown(): Promise<void> {
    this.draining = true;
    // Stop new matchmaking — a locked room is removed from availability.
    await this.lock();
    // Notify in-flight clients (not a silent kill). If the match is already over
    // (winnerTeam set), the framework disposes promptly; otherwise the drain
    // window lets the live match wind down.
    this.broadcast("serverDraining", { reason: "deploy" });
  }
}
