import tseslint from "typescript-eslint";

// SIM-04 purity gate: packages/shared (@shared/sim) must stay engine-free,
// network-free, and DOM-free. These bans are enforced at lint time so the
// boundary is structural, not a matter of discipline.
export default tseslint.config(
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
    },
  },
);
