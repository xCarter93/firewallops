/// <reference types="vite/client" />

// DEBUG_OVERLAY gates the dev-only full-arc trajectory overlay (plans 03/04).
// import.meta.env.DEV is a Vite static replacement: true under `vite dev`,
// false under `vite build`, so the overlay tree-shakes out of production.
// Keep this module pure — it must NOT import @shared/sim.
export const DEBUG_OVERLAY = import.meta.env.DEV;
