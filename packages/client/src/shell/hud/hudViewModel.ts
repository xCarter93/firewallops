/**
 * hudViewModel.ts — the PURE HUD view-model seam.
 *
 * This module is the single unit-testable Nyquist seam for the Phase-6 HUD:
 *   - UI-02  turn list (active row + accumulatedDelay ordering + countdown helpers)
 *   - UI-03  per-row hp + eliminated
 *   - CF-1   per-row connected (peer-disconnect indicator)
 *   - SC-1   the action-bar DISPLAY MIRROR (live power/angle/selected-weapon/charge
 *            derived from the LOCAL seated player's mobile)
 *
 * PURITY CONTRACT (locked, RESEARCH Pattern 1 + 06-CONTEXT): this file declares
 * ONLY types + pure functions over plain-object inputs. It has ZERO imports from
 * `phaser`, `colyseus.js`, `@colyseus/sdk`, `@colyseus/schema`, or any DOM type.
 * It never touches the DOM, a Phaser scene, or a live room — every consumer
 * (overlay 06-03, binding 06-04, preview) reads these types and this reducer.
 *
 * Ground truth: verified against packages/server/src/rooms/schema/MatchState.ts
 * (the wire format) on 2026-06-21. The VM may only mirror fields that appear on
 * the synced `Mobile`/`MatchState`. Fields NOT synced are surfaced as sentinels,
 * never invented numbers (06-CONTEXT empty-state rule):
 *   - `moveBudget`  → -1  (server comment: movement is client-local cosmetic)
 *   - `round`       → -1  (MatchState has no round/turn-count field)
 * The overlay renders these sentinels as an em-dash.
 */

// ─────────────────────────── structural inputs ──────────────────────────────
// Mirror MatchScene's SyncedState/SyncedMobile (scenes/MatchScene.ts:99-124),
// EXTENDED with the synced fields the action bar + identity need (all verified
// present on the wire in MatchState.ts). `connected`, `powerLocked`, and
// `displayName` are optional here ONLY because the scene's local SyncedMobile
// type currently omits some of them (plan 02 adds `connected` to the scene
// type); all three are present on the wire. Treat a missing `connected` as
// `true`, a missing `powerLocked` as `false`, and a missing/empty `displayName`
// as triggering the resolveLabel fallback chain.

export interface SyncedMobileLike {
  sessionId: string;
  team: number;
  x: number;
  y: number;
  hp: number;
  angleDeg: number;
  power: number;
  powerLocked?: boolean;
  facing: number;
  ssHitCharge: number;
  accumulatedDelay: number;
  selectedItemId: string;
  displayName?: string;
  connected?: boolean;
}

export interface SyncedLike {
  phase: string;
  activePlayer: string;
  wind: number;
  turnEndsAt: number;
  winnerTeam: number;
  mobiles?: {
    forEach(cb: (m: SyncedMobileLike, key: string) => void): void;
    size: number;
  };
}

// ───────────────────────────── exported types ───────────────────────────────

/** One row in the turn list (UI-02 / UI-03 / CF-1 + review concern 7 identity). */
export interface HudTurnRow {
  id: string;
  label: string;
  isLocal: boolean;
  hp: number;
  isActive: boolean;
  eliminated: boolean;
  connected: boolean;
  team: number;
}

/** One minimap blip (normalized x position). */
export interface HudBlip {
  id: string;
  xFrac: number;
  team: number;
  isActive: boolean;
}

/** A weapon chip in the action bar (display mirror for PACKET/FORKED/TROJAN). */
export interface HudWeapon {
  id: string;
  label: string;
  selected: boolean;
  locked: boolean;
  chargeLabel?: string;
}

/**
 * The SC-1 live DISPLAY-MIRROR of the LOCAL seated player's action state
 * (review concern 1). Derived from the local mobile; neutral defaults when the
 * local sessionId has no mobile (spectator / pre-seat). `moveBudget` is the
 * not-synced sentinel `-1`; `hasLocalMobile` lets the overlay render neutral
 * chrome.
 */
export interface HudActionBar {
  weapons: HudWeapon[];
  power: number;
  angleDeg: number;
  selectedItemId: string;
  ssHitCharge: number;
  powerLocked: boolean;
  moveBudget: number;
  hasLocalMobile: boolean;
}

/** A chat line (plain data; the overlay renders via textContent, never innerHTML). */
export interface HudChatMessage {
  id: string;
  author: string;
  text: string;
}

/** The whole HUD view-model — the single render input. */
export interface HudViewModel {
  round: number;
  phase: string;
  activeLabel: string;
  activeIsLocal: boolean;
  localPlayerId: string;
  turnRows: HudTurnRow[];
  wind: number;
  blips: HudBlip[];
  actionBar: HudActionBar;
  winnerTeam: number;
  matchOver: boolean;
}

// ───────────────────────────── constants ────────────────────────────────────

/** Minimap denominator — copied literal of MAP.width (world.ts), NOT an import. */
export const MAP_WIDTH = 2048;

/** Trojan-arm threshold — the server caps `ssHitCharge` at this (Authority Decision 5). */
export const SS_HITS_TO_ARM = 3;

/**
 * The three weapon chips, in display order. `selectedItemId` maps each chip to
 * the server's `selectedItemId` wire value (the loadout ids — default `"shot-1"`
 * per the schema). See SUMMARY "weapon id mapping" for the assumption note.
 */
const WEAPON_CHIPS: ReadonlyArray<{ id: string; label: string; selectedItemId: string }> = [
  { id: "packet", label: "PACKET", selectedItemId: "shot-1" },
  { id: "forked", label: "FORKED", selectedItemId: "shot-2" },
  { id: "trojan", label: "TROJAN", selectedItemId: "trojan" },
];

function neutralWeapons(): HudWeapon[] {
  return WEAPON_CHIPS.map((c) => ({
    id: c.id,
    label: c.label,
    selected: false,
    locked: false,
  }));
}

/** A frozen empty view-model — returned on the undefined-mobiles guard. */
export const EMPTY_VM: HudViewModel = Object.freeze({
  round: -1,
  phase: "",
  activeLabel: "",
  activeIsLocal: false,
  localPlayerId: "",
  turnRows: [],
  wind: 0,
  blips: [],
  actionBar: {
    weapons: neutralWeapons(),
    power: 0,
    angleDeg: 0,
    selectedItemId: "",
    ssHitCharge: 0,
    powerLocked: false,
    moveBudget: -1,
    hasLocalMobile: false,
  },
  winnerTeam: -1,
  matchOver: false,
});

// ───────────────────────────── helpers ──────────────────────────────────────

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Review concern 7 fallback chain (no fabricated identity): local seat → "YOU";
 * else the synced `displayName`; else the team label; else a short session id.
 */
export function resolveLabel(m: SyncedMobileLike, isLocal: boolean): string {
  if (isLocal) return "YOU";
  const name = (m.displayName ?? "").trim();
  if (name) return name;
  if (m.team === 0) return "TEAM A";
  if (m.team === 1) return "TEAM B";
  return m.sessionId.slice(0, 6);
}

/**
 * Build the live action-bar mirror from the LOCAL mobile (review concern 1 /
 * SC-1). Neutral chrome when there is no local mobile.
 */
function buildActionBar(lm: SyncedMobileLike | undefined): HudActionBar {
  const hasLocalMobile = lm !== undefined;
  const ssHitCharge = lm?.ssHitCharge ?? 0;
  const selectedItemId = lm?.selectedItemId ?? "";

  const weapons: HudWeapon[] = WEAPON_CHIPS.map((c) => {
    const selected = hasLocalMobile && lm?.selectedItemId === c.selectedItemId;
    if (c.id === "trojan") {
      return {
        id: c.id,
        label: c.label,
        selected,
        // Neutral chrome when there is no local mobile (plan: !hasLocalMobile → unlocked).
        locked: hasLocalMobile && ssHitCharge < SS_HITS_TO_ARM,
        chargeLabel: `${Math.min(ssHitCharge, SS_HITS_TO_ARM)}/${SS_HITS_TO_ARM}`,
      };
    }
    return { id: c.id, label: c.label, selected, locked: false };
  });

  return {
    weapons,
    power: lm?.power ?? 0,
    angleDeg: lm?.angleDeg ?? 0,
    selectedItemId,
    ssHitCharge,
    powerLocked: lm?.powerLocked === true,
    // NOT synced — sentinel, never an invented number (ground-truth note).
    moveBudget: -1,
    hasLocalMobile,
  };
}

// ───────────────────────────── reducer ──────────────────────────────────────

/**
 * The pure HUD reducer. Reads a read-only mirror of authoritative match state +
 * the local sessionId; returns the full HudViewModel. No side effects, no I/O.
 */
export function buildViewModel(state: SyncedLike, sessionId: string): HudViewModel {
  // Canonical undefined-mobiles guard: `mobiles` (MapSchema) is undefined until
  // the first patch decodes (RESEARCH anti-pattern; MatchScene:434).
  if (!state.mobiles) return EMPTY_VM;

  const list: SyncedMobileLike[] = [];
  let localMobile: SyncedMobileLike | undefined;
  let activeMobile: SyncedMobileLike | undefined;

  state.mobiles.forEach((m, key) => {
    const id = m.sessionId || key;
    // Normalize so downstream sees a stable id even when sessionId is empty.
    const mob: SyncedMobileLike = m.sessionId ? m : { ...m, sessionId: id };
    list.push(mob);
    if (mob.sessionId === sessionId) localMobile = mob;
    if (mob.sessionId === state.activePlayer) activeMobile = mob;
  });

  // Lowest accumulatedDelay acts next (PLAY-06) — the exact rule MatchScene uses.
  list.sort((a, b) => a.accumulatedDelay - b.accumulatedDelay);

  const turnRows: HudTurnRow[] = list.map((m) => {
    const isLocal = m.sessionId === sessionId;
    return {
      id: m.sessionId,
      label: resolveLabel(m, isLocal),
      isLocal,
      hp: m.hp,
      isActive: m.sessionId === state.activePlayer,
      eliminated: m.hp <= 0,
      connected: m.connected !== false, // missing = connected
      team: m.team,
    };
  });

  const blips: HudBlip[] = list.map((m) => ({
    id: m.sessionId,
    xFrac: clamp01(m.x / MAP_WIDTH),
    team: m.team,
    isActive: m.sessionId === state.activePlayer,
  }));

  const actionBar = buildActionBar(localMobile);

  const activeIsLocal = state.activePlayer === sessionId;
  let activeLabel = "";
  if (activeIsLocal) {
    activeLabel = "YOUR TURN";
  } else if (activeMobile) {
    activeLabel = `${resolveLabel(activeMobile, false)}'S TURN`;
  }

  return {
    // No synced round field on MatchState — sentinel, never an invented number.
    round: -1,
    phase: state.phase,
    activeLabel,
    activeIsLocal,
    localPlayerId: sessionId,
    turnRows,
    wind: state.wind,
    blips,
    actionBar,
    winnerTeam: state.winnerTeam,
    matchOver: state.winnerTeam >= 0,
  };
}

// ───────────────────────────── countdown helpers ────────────────────────────

/**
 * Turn ms-remaining into "M:SS" (SS zero-padded). Clamps to >= 0 so a stale
 * deadline never renders a negative readout. Mirrors MatchScene:764 but pure.
 */
export function formatCountdown(msRemaining: number): string {
  const ms = msRemaining > 0 ? msRemaining : 0;
  const secs = Math.ceil(ms / 1000);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}:${rem < 10 ? "0" : ""}${rem}`;
}

/**
 * The countdown shows only while AIMING AND when the server posts a POSITIVE
 * deadline. Training disables the turn timer and sends `turnEndsAt === 0` (the
 * "no timer" contract), so the `turnEndsAt > 0` gate is what suppresses the stale
 * ticking readout there — a real match always carries a positive deadline.
 */
export function shouldShowCountdown(phase: string, turnEndsAt: number): boolean {
  return phase === "AIMING" && turnEndsAt > 0;
}
