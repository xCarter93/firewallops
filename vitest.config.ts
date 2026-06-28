import { defineConfig } from "vitest/config";

// SIM-04: the sim suite runs in bare Node (no jsdom/DOM). environment: "node"
// makes that explicit; the CI/verify path always uses `vitest run` (no watch).
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/shared/test/**/*.test.ts",
      "packages/client/src/**/*.test.ts",
      // The client DOM smoke test (Plan 09) lives under test/; it scopes its own
      // jsdom environment via a `// @vitest-environment jsdom` pragma so the
      // bare-Node default (environment: "node") still governs every other suite.
      "packages/client/test/**/*.test.ts",
      // The golden NET-01 parity test (client preview ↔ server authority) was
      // relocated here from packages/server/test/ at the Colyseus cutover (09-12,
      // review [S]) so the highest-value invariant survives the server deletion. It
      // imports pure logic from @firewallops/match-core + the client MatchController.
      "packages/match-core/test/**/*.test.ts",
    ],
  },
});
