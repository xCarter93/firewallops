import { describe, it, expect } from "vitest";
import { TerrainMask } from "@shared/sim";
import {
  MAP,
  runServerShot,
  type ServerMech,
  shouldResolveFire,
  fireSchema,
  SS_HITS_TO_ARM,
  GRAVITY,
} from "@firewallops/match-core";
import { SHOT_1, TROJAN, muzzleOffset } from "@shared/sim";
import type { ShotInput } from "@shared/sim";

/**
 * Gate-before-logic integration tests (Codex/Cursor MEDIUM) — NET-02 / NET-07 /
 * Authority Decision 5. These assert the FULL handler decision (the same
 * `shouldResolveFire` predicate the Room's onFire uses) drops out-of-turn /
 * wrong-phase / out-of-range / unarmed-Trojan fires BEFORE the resolver runs and
 * BEFORE any HP/delay mutation.
 *
 * Headless harness: a flagged resolver records whether it was invoked, and a
 * plain `Mobile`-like record stands in for the schema. No live WS server.
 */

interface FakeMobile extends ServerMech {
  team: number;
  accumulatedDelay: number;
  ssHitCharge: number;
  selectedItemId: string;
  angleDeg: number;
  power: number;
}

function makeMobile(over: Partial<FakeMobile> = {}): FakeMobile {
  return {
    id: "active",
    team: 0,
    x: 980,
    y: 360,
    hp: 100,
    accumulatedDelay: 0,
    ssHitCharge: 0,
    selectedItemId: "shot-1",
    angleDeg: 60,
    power: 70,
    ...over,
  };
}

/**
 * The Room's onFire decision + effect, extracted into a headless harness that
 * uses the SAME `shouldResolveFire` predicate and the SAME runServerShot path.
 * `resolved` flips true only if the resolver actually ran.
 */
function simulateFire(args: {
  phase: string;
  senderId: string;
  activePlayer: string;
  itemId: string;
  mobile: FakeMobile;
  terrain: TerrainMask;
  allMechs: ServerMech[];
}): { resolved: boolean } {
  const ok = shouldResolveFire({
    phase: args.phase,
    senderId: args.senderId,
    activePlayer: args.activePlayer,
    itemId: args.itemId,
    ssHitCharge: args.mobile.ssHitCharge,
    ssHitsToArm: SS_HITS_TO_ARM,
  });
  if (!ok) return { resolved: false };

  const def = args.itemId === "trojan" ? TROJAN : SHOT_1;
  const origin = muzzleOffset(args.mobile.x, args.mobile.y, args.mobile.angleDeg);
  const aim: ShotInput = {
    x: origin.x,
    y: origin.y,
    angleDeg: args.mobile.angleDeg,
    power: args.mobile.power,
    wind: 0,
    gravity: GRAVITY,
    projectile: def,
  };
  runServerShot(aim, def, args.terrain, args.allMechs);
  return { resolved: true };
}

describe("roomHandlers: gate before logic (NET-02 / NET-07 / arming)", () => {
  it("out-of-turn fire does not resolve or mutate state", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const mobile = makeMobile({ id: "sender" });
    const allMechs: ServerMech[] = [
      { id: "sender", x: 980, y: 360, hp: 100 },
      { id: "active", x: 1140, y: 405, hp: 100 },
    ];
    const hpBefore = allMechs.map((m) => m.hp);

    const { resolved } = simulateFire({
      phase: "AIMING",
      senderId: "sender", // NOT the active player
      activePlayer: "active",
      itemId: "shot-1",
      mobile,
      terrain,
      allMechs,
    });

    expect(resolved).toBe(false);
    expect(allMechs.map((m) => m.hp)).toEqual(hpBefore);
  });

  it("wrong-phase fire does not resolve", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const mobile = makeMobile();
    const allMechs: ServerMech[] = [{ id: "active", x: 980, y: 360, hp: 100 }];
    const hpBefore = allMechs.map((m) => m.hp);

    const { resolved } = simulateFire({
      phase: "RESOLVING", // not AIMING
      senderId: "active",
      activePlayer: "active",
      itemId: "shot-1",
      mobile,
      terrain,
      allMechs,
    });

    expect(resolved).toBe(false);
    expect(allMechs.map((m) => m.hp)).toEqual(hpBefore);
  });

  it("trojan fire rejected when unarmed (ssHitCharge < SS_HITS_TO_ARM)", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const mobile = makeMobile({ ssHitCharge: SS_HITS_TO_ARM - 1 });
    const allMechs: ServerMech[] = [
      { id: "active", x: 980, y: 360, hp: 100 },
      { id: "target", x: 1140, y: 405, hp: 100 },
    ];
    const hpBefore = allMechs.map((m) => m.hp);

    const { resolved } = simulateFire({
      phase: "AIMING",
      senderId: "active",
      activePlayer: "active",
      itemId: "trojan",
      mobile,
      terrain,
      allMechs,
    });

    expect(resolved).toBe(false);
    expect(allMechs.map((m) => m.hp)).toEqual(hpBefore);
  });

  it("a valid in-turn armed fire DOES resolve (control)", () => {
    const terrain = TerrainMask.fromMap(MAP);
    const mobile = makeMobile({ ssHitCharge: SS_HITS_TO_ARM });
    const allMechs: ServerMech[] = [
      { id: "active", x: 980, y: 360, hp: 100 },
      { id: "target", x: 1140, y: 405, hp: 100 },
    ];

    const { resolved } = simulateFire({
      phase: "AIMING",
      senderId: "active",
      activePlayer: "active",
      itemId: "trojan",
      mobile,
      terrain,
      allMechs,
    });

    expect(resolved).toBe(true);
  });
});

describe("roomHandlers: out-of-range fire is rejected before logic (NET-07)", () => {
  it("a power:101 payload fails the fire schema so the handler never runs", () => {
    // The validate() layer is the boundary: a payload failing the schema is
    // dropped before onFire is invoked, so resolution can never run on it.
    // (Schema rejection is also covered in messages.test.ts; this anchors the
    // gate-before-logic story for out-of-range input.)
    const parsed = fireSchema.safeParse({
      angleDeg: 0,
      power: 101,
      itemId: "shot-1",
    });
    expect(parsed.success).toBe(false);
  });
});
