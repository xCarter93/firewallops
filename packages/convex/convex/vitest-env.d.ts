/**
 * Ambient type shim for `import.meta.glob` (Vite/Vitest), used by
 * `convex/match.test.ts` to feed every Convex module to
 * `convexTest(schema, modules)`.
 *
 * The Convex tsconfig (`convex/tsconfig.json`) does not pull in `vite/client`
 * types — `vite` is only a transitive dependency of `vitest` and is not
 * resolvable via `/// <reference types="vite/client" />` from this package under
 * pnpm's symlinked layout. We declare ONLY the lazy (non-eager) `glob` form
 * convex-test needs — `Record<path, () => Promise<module>>` — mirroring the
 * surgical `env.d.ts` approach rather than taking on a direct `vite` dep.
 *
 * `.d.ts` is type-only — never registered as a Convex function or deployed.
 */
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
