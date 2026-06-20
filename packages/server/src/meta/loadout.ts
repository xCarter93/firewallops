/**
 * Meta API stub — loadout read seam.
 *
 * v0 returns defaults for every accountId; real avatar/economy resolution is
 * post-v0 (the seam exists, not the logic). Real persistence lands with the
 * Postgres work in a later phase. This is a Meta-API seam, not the sim loadout —
 * the three default ids mirror the client loadout (`shot-1`, `shot-2`, `trojan`).
 */

export const DEFAULT_LOADOUT = {
  items: ["shot-1", "shot-2", "trojan"] as const,
};

export function getLoadout(_accountId: string): { items: readonly string[] } {
  return DEFAULT_LOADOUT;
}
