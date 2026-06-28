/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

/**
 * Convex authority test config (Phase 9, Plan 04 — Wave-0 harness).
 *
 * `convex-test` runs the Convex functions in a JS sandbox that mirrors the
 * Convex V8 isolate. It REQUIRES the `edge-runtime` Vitest environment
 * (`@edge-runtime/vm`) so the test runtime matches Convex's Cloudflare-Workers-
 * like isolate (no Node built-ins) — running under the default `node`
 * environment fails (`09-RESEARCH.md` §"Validation Architecture", Wave 0).
 *
 * `server.deps.inline: ["convex-test"]` is the documented requirement so Vitest
 * transforms `convex-test`'s ESM rather than treating it as an external CJS dep.
 *
 * convex-test discovers the Convex modules at runtime via the
 * `import.meta.glob("./convex/**\/*.ts")` map the test passes to `convexTest`
 * (see `convex/match.test.ts`); this config only wires the runtime + transform.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
  },
});
