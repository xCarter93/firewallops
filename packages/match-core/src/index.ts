/**
 * @firewallops/match-core public API barrel (Phase 9, Plan 02 — review [B]).
 *
 * package.json `main`/`types`/`exports` point at this file, so `@firewallops/
 * match-core` resolves to ONE root export. The server tests AND the Convex
 * authority functions (plans 04-05) import the pure match logic from HERE —
 * `seatsFull`/`runServerShot`/`MAP`/`teamSizeForMode`/etc. — so there is a single
 * home for the engine-free logic shared by the (soon-deleted) Colyseus server and
 * the new Convex mutations.
 *
 * Without this barrel + the `@firewallops/match-core` workspace dep on
 * packages/convex, the Convex bundle cannot resolve these imports (review [B]).
 *
 * PURITY: every re-exported module imports NOTHING from the realtime engine and
 * only `@shared/sim` + `zod` + each other. This package is DOM-free and
 * V8-isolate targeted (Convex), mirroring the `@shared/sim` purity posture.
 */

export * from "./turnMachine.js";
export * from "./resolve.js";
export * from "./shotResult.js";
export * from "./world.js";
export * from "./config.js";
export * from "./messageSchemas.js";
export * from "./matchPersistence.js";
