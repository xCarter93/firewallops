import { defineConfig } from "vitest/config";

// SIM-04: the sim suite runs in bare Node (no jsdom/DOM). environment: "node"
// makes that explicit; the CI/verify path always uses `vitest run` (no watch).
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/shared/test/**/*.test.ts",
      "packages/client/src/**/*.test.ts",
    ],
  },
});
