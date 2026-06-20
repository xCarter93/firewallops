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
import { Room, Client, validate } from "@colyseus/core";
import { TerrainMask, encodeMaskRLE, muzzleOffset, LOADOUT } from "@shared/sim";
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
  MATCH_CONFIG,
  resolveDwellMs,
} from "../config.js";
import { MAP, spawnLayout, surfaceY, settledY } from "../match/world.js";
import { runServerShot, type ServerMech } from "../match/resolve.js";
import {
  advanceTurn,
  checkWinTeam,
  assignTeam,
  seatsFull,
  timeoutOutcome,
  canFire,
  shouldResolveFire,
  type TurnMobile,
} from "../match/turnMachine.js";
import {
  fireSchema,
  aimSchema,
  selectItemSchema,
  type FireMessage,
  type AimMessage,
  type SelectItemMessage,
} from "../match/messageSchemas.js";
import { recordMatchResult } from "../meta/results.js";

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
  };

  onCreate(): void {
    this.state = new MatchState();
    // Authoritative mask in room memory ONLY (Pitfall 4 / NET-05). Built from
    // the server MAP — byte-identical to the client world.ts so carves replay
    // identically on every client.
    this.terrain = TerrainMask.fromMap(MAP);
  }

  /**
   * Stub identity handshake (Plan 02) — a per-session guest accountId becomes
   * `client.auth.accountId`. Real Clerk verifyToken is Phase 5.
   */
  async onAuth(
    client: Client,
    _options: unknown,
    _context: unknown,
  ): Promise<{ accountId: string }> {
    return { accountId: `guest-${client.sessionId}` };
  }

  /**
   * NET-05: terrain snapshot + auto-balance + auto-start + full-room lock.
   * Overflow joiners are rejected (Agreed Concern #3 / Authority Decision 3).
   */
  onJoin(client: Client): void {
    // Overflow guard FIRST — a third tab in 1v1 (or beyond teamSize*2) is
    // rejected with a logged normal-close leave, before any seat is created.
    if (seatsFull(this.state.mobiles.size, MATCH_CONFIG.teamSize)) {
      console.warn(
        `[match] full (${MATCH_CONFIG.teamSize * 2} seats) — rejecting ${client.sessionId}`,
      );
      client.leave(1000);
      return;
    }

    const joinOrder = this.state.mobiles.size;
    const team = assignTeam(joinOrder, MATCH_CONFIG.teamSize);

    // Seat from the server spawn layout (mask surface Y). The layout fills in
    // JOIN order A,B,A,B… so layout[joinOrder] aligns with assignTeam(joinOrder).
    const seats = spawnLayout(this.terrain, MATCH_CONFIG.teamSize);
    const seat = seats[joinOrder];

    const mobile = new Mobile();
    mobile.sessionId = client.sessionId;
    mobile.team = team;
    mobile.facing = team === 0 ? 1 : -1; // A faces right, B faces left
    mobile.x = seat.x;
    mobile.y = seat.y;
    mobile.hp = 100;
    this.state.mobiles.set(client.sessionId, mobile);

    // One-time RLE terrain snapshot as RAW BYTES (NET-05). sendBytes keeps the
    // bytes intact; client.send would msgpack-encode and corrupt them.
    client.sendBytes("terrainSnapshot", encodeMaskRLE(this.terrain));

    // Lock + auto-start the moment every seat is filled (Authority Decision 3).
    if (seatsFull(this.state.mobiles.size, MATCH_CONFIG.teamSize)) {
      void this.lock();
      this.startTurn();
    }
  }

  onLeave(client: Client, code?: number): void {
    console.warn(`[match] ${client.sessionId} left (code ${code ?? "?"})`);
    // Active-disconnect-during-RESOLVING note (Cursor MEDIUM): if the leaver is
    // the active player mid-resolve, the in-flight resolveActiveShot already
    // broadcast its result before any await, so the schema is consistent — the
    // turn timer / next startTurn carries the match forward. True reconnection
    // (allowReconnection) is Phase 5; the auto-forfeit timer is the Phase 3
    // mitigation for a silent/dropped active player.
    if (
      client.sessionId === this.state.activePlayer &&
      this.state.phase === "RESOLVING"
    ) {
      console.warn(
        `[match] active player ${client.sessionId} left during RESOLVING — timer carries the match forward`,
      );
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

  private onAim(client: Client, payload: AimMessage): void {
    if (!canFire(this.state.phase, client.sessionId, this.state.activePlayer)) {
      return;
    }
    const mobile = this.state.mobiles.get(client.sessionId);
    if (!mobile) return;

    // Stream the aim (drives the spectator barrel render AND the timeout
    // auto-fire). powerLocked is set ONLY on an explicit commit/release flag
    // (Agreed Concern #6) — a mid-charge throttled aim leaves it false, so a
    // timeout on a partial charge SKIPS rather than auto-firing a half shot.
    mobile.angleDeg = payload.angleDeg;
    mobile.power = payload.power;
    mobile.powerLocked = payload.committed === true;
  }

  private onSelectItem(client: Client, payload: SelectItemMessage): void {
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

    const def: ProjectileDef = LOADOUT[itemId as keyof typeof LOADOUT];

    // Map synced mobiles → plain ServerMech[] for the pure resolver.
    const mechs: ServerMech[] = [];
    this.state.mobiles.forEach((m) => {
      mechs.push({ id: m.sessionId, x: m.x, y: m.y, hp: m.hp });
    });

    // Launch origin = the SHARED barrel tip (Authority Decision 4), NOT the raw
    // mobile center — so the authoritative arc matches the client aim preview.
    const origin = muzzleOffset(active.x, active.y, angleDeg);
    const aim: ShotInput = {
      x: origin.x,
      y: origin.y,
      angleDeg,
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

  private endMatch(winnerTeam: number): void {
    this.state.phase = "RESULTS";
    this.state.winnerTeam = winnerTeam;
    this.broadcast("matchEnded", { winnerTeam });
    // In-process authoritative write (review H7 preferred path). The roomId is a
    // stable per-match idempotency key so a re-record is a no-op.
    recordMatchResult({ winnerTeam, resultId: this.roomId });
  }

  /** Simultaneous-wipe draw (Codex MEDIUM) — winnerTeam -1 sentinel, never silent. */
  private endMatchDraw(): void {
    this.state.phase = "RESULTS";
    this.state.winnerTeam = -1;
    this.broadcast("matchEnded", { winnerTeam: -1, draw: true });
    recordMatchResult({ winnerTeam: -1, resultId: this.roomId });
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
