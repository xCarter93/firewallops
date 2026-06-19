/**
 * @shared/sim — public API type contract.
 *
 * This file declares the shapes that Phases 2 (Phaser client) and 3 (Colyseus
 * server) build against. It is intentionally pure data + behavior interfaces:
 * no engine, no network, no DOM.
 *
 * Coordinate system: origin top-left, y is screen-DOWN, x is screen-RIGHT.
 * angleDeg: 0 = right, 90 = straight up (the integrator negates sin for y-down).
 */

/** A sampled point along a projectile's flight path. */
export interface TrajectoryPoint {
  x: number;
  y: number;
  /** Seconds since launch (step * dt, dt = 1/120). */
  t: number;
}

/**
 * The data + behavior reference for a projectile. Per CONTEXT, every lethality
 * and physics scalar lives HERE (on the def), not as a global constant, so
 * different mechs/items can differ without a sim-core rewrite.
 */
export interface ProjectileDef {
  id: string;
  /**
   * Key naming the registered ProjectileBehavior (e.g. the default ballistic
   * shot vs. an alternate). This is the pluggable-seam reference: the integrator
   * routes through `getBehavior(behavior)`, never a hardcoded default.
   */
  behavior: string;

  // --- Blast-damage anchors (all on the def, not globals) ---
  /** Peak damage at the blast center before the direct-hit bonus. */
  maxDamage: number;
  /** Pixel radius of the blast; beyond it, damage is 0. */
  blastRadius: number;
  /** Minimum chip any mech inside blastRadius takes (a graze always counts). */
  grazeFloor: number;
  /** Pixel threshold from the mech center that qualifies as a direct hit. */
  directHitThreshold: number;
  /** Bonus damage added on top of the falloff curve for a direct hit. */
  directHitBonus: number;

  // --- Flight / physics scalars ---
  /** Feeds powerToSpeed: scales the fired power into a launch speed. */
  powerScale: number;
  /**
   * RESERVED in Phase 1: declared on the def (the per-mech-stats seam,
   * dimension 4) but DEFAULT_BEHAVIOR.step does NOT consume `mass` yet. Real
   * mass/drag flight tuning is deferred to MECH-01 (v2). The field exists now
   * so the data model does not churn when a real mech wires it in.
   */
  mass: number;
  /**
   * RESERVED in Phase 1 (see `mass`): declared but NOT consumed by the default
   * behavior yet. Deferred to MECH-01 (v2).
   */
  drag: number;

  // --- Multi-projectile (dimension 2) ---
  /** Angular spread for sub-shots; default behavior leaves it undefined. */
  spread?: number;
  /** Number of sub-projectiles to spawn; default behavior treats it as 1. */
  subProjectileCount?: number;

  /**
   * RESERVED field: Phase 1 does NOT act on `turnDelay`. The Phase 3 turn state
   * machine owns it. Reserved now so the data model does not churn later.
   */
  turnDelay: number;
}

/**
 * A single fired shot. Matches TECHNICAL-DESIGN §2.2.
 * angleDeg: 0 = right, 90 = up; y is screen-down.
 */
export interface ShotInput {
  x: number;
  y: number;
  angleDeg: number;
  power: number;
  wind: number;
  gravity: number;
  projectile: ProjectileDef;
}

/**
 * Procedural heightmap definition consumed by `TerrainMask.fromMap`.
 *
 * Fixed spike map: 1024 x 512 px, origin top-left, y-down (matches the future
 * Phaser client). The heightmap is a deterministic function of `seed` + the
 * sine params so server and client build byte-identical masks.
 */
export interface MapDef {
  width: number;
  height: number;
  seed: number;
  /** Baseline ground height (distance from the top in y-down space). */
  baseHeight: number;
  /** Peak-to-trough amplitude of the summed-sine surface. */
  amplitude: number;
  /** Horizontal frequency of the summed-sine surface. */
  frequency: number;
}

/**
 * A quantized carve record: INTEGER center + radius. This is the exact shape
 * returned by the shared `quantizeCarve` helper that BOTH `carveCircle` and
 * `resolveShot` route through — the single float→int quantization boundary that
 * makes the SIM-04 byte-identical guarantee hold. Matches TECHNICAL-DESIGN §5.2.
 */
export interface Carve {
  cx: number;
  cy: number;
  r: number;
}

/** Per-mech damage from a resolved shot. Matches TECHNICAL-DESIGN §5.2. */
export interface Damage {
  mechId: string;
  amount: number;
}

/** Minimal mech shape for resolveShot input (Phase 1 needs position + hp + id). */
export interface Mech {
  id: string;
  x: number;
  y: number;
  hp: number;
}

/** Context passed to the flight hook each integration step. */
export interface FlightContext {
  wind: number;
  gravity: number;
  /** Seconds since launch. */
  t: number;
  /** Integer step index. */
  step: number;
}

/** Mutable per-step kinematic state passed to the flight hook. */
export interface FlightState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The pluggable projectile strategy object. All THREE behavioral dimensions
 * hang off this one interface so the seam is first-class from Phase 1 (not just
 * the array return shape). `ProjectileDef = data + a reference to one of these`.
 */
export interface ProjectileBehavior {
  /**
   * Dimension 1 — custom flight/steering. Per-step force hook the integrator
   * calls each step. The default returns plain wind+gravity; an alternate may
   * couple force to velocity/time (e.g. a wind-riding "boomerang" shot).
   */
  step(state: FlightState, ctx: FlightContext, def: ProjectileDef): {
    fx: number;
    fy: number;
  };

  /**
   * Dimension 2 — multi-projectile spawn. One fired shot expands into N
   * sub-shots. The DEFAULT returns `[input]` (single-shot passthrough);
   * `resolveShot` (plan 04) loops over the returned sub-shots so multi-impact is
   * native via the seam. Phase 1 ships only the single-shot default; a real
   * spread mech is deferred to MECH-01 (v2).
   */
  createSubShots(input: ShotInput, def: ProjectileDef): ShotInput[];

  /**
   * Dimension 3 — custom damage combination. Merge rule for overlapping
   * sub-impacts (not naive summing). `perImpact[i]` is the damage array from the
   * i-th sub-impact; the rule combines them into one per-mech damage list.
   */
  combineDamage(perImpact: Damage[][], def: ProjectileDef): Damage[];
}
