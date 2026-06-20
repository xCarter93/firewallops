import tseslint from "typescript-eslint";

// SIM-04 purity gate: packages/shared (@shared/sim) must stay engine-free,
// network-free, and DOM-free. These bans are enforced at lint time so the
// boundary is structural, not a matter of discipline.
export default tseslint.config(
  // Global ignores: never lint build output, deps, or repo tooling. Without
  // this, `eslint .` walks packages/client/dist (minified phaser bundle) and
  // .claude/hooks (vendored GSD harness scripts) and floods with errors.
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".claude/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "phaser",
              message: "@shared/sim must stay engine-free — no game-engine imports.",
            },
            {
              name: "colyseus",
              message: "@shared/sim must stay network-free — no networking imports.",
            },
            {
              name: "jsdom",
              message: "@shared/sim is tested in bare Node — no DOM test environments (SIM-04).",
            },
            {
              name: "happy-dom",
              message: "@shared/sim is tested in bare Node — no DOM test environments (SIM-04).",
            },
          ],
          patterns: [
            "@colyseus/*",
            "phaser/*",
            "@vitest/browser",
            "@vitest/browser/*",
          ],
        },
      ],
      "no-restricted-globals": ["error", "window", "document"],
      // Honor the leading-underscore convention for intentionally unused
      // parameters (e.g. the Phase-1 throw-stub signatures, which declare the
      // real shape but do not consume their args yet).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Seam purity gate (mirrors the SIM-04 shared gate): src/match/** is the
  // headless seam — the Phase 3 swap point — and MUST stay phaser-free so the
  // MatchController/loadout logic is testable in bare Node.
  {
    files: ["packages/client/src/match/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "phaser",
              message:
                "src/match/** is the headless seam (Phase 3 swap point) — no phaser imports here.",
            },
          ],
          patterns: ["phaser/*"],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Seam-DIRECTION guard (mechanical enforcement of the single seam, threats
  // T-02-04/T-02-07): Scenes and views MUST route outcome sim through
  // MatchController.applyShot()/previewTrajectory(), never call the sim's
  // outcome functions directly. Ban ONLY the three named outcome imports —
  // TerrainMask/MapDef (BootScene mask build), Carve/Damage, and all type-only
  // imports stay allowed. A broad name ban WITHOUT importNames would break the
  // legitimate mask build, so do not widen this.
  {
    files: [
      "packages/client/src/scenes/**/*.ts",
      "packages/client/src/view/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@shared/sim",
              importNames: [
                "resolveShot",
                "simulateTrajectory",
                "quantizeCarve",
              ],
              message:
                "Scenes/views must go through MatchController.applyShot()/previewTrajectory() — the Phase 3 seam. Outcome sim calls live only in src/match/**.",
            },
          ],
        },
      ],
    },
  },
  // @firewallops/server (Phase 3): honor the same leading-underscore convention
  // for intentionally unused params. The v0 stub seams declare their real
  // signatures but do not consume every arg yet — onAuth(_options, _context),
  // getLoadout(_accountId), recordMatchResult(_payload) — so the shape is fixed
  // for Plan 03/04 + Phase 5 (Clerk/economy) without tripping no-unused-vars.
  {
    files: ["packages/server/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
