import { defineConfig } from "vite";

// RESEARCH Pattern 7 (A2 de-risk): @shared/sim ships its raw .ts source
// (exports → ./src/index.ts, no build step). optimizeDeps.exclude stops Vite's
// esbuild pre-bundling from choking on the linked dep and makes Vite transform
// its .ts on the fly instead. base "./" matches the official Phaser template
// for relative asset paths. phaser is split into its own chunk.
export default defineConfig({
  base: "./",
  optimizeDeps: {
    exclude: ["@shared/sim"],
  },
  build: {
    rollupOptions: {
      output: {
        // Vite 8 / Rolldown requires manualChunks in FUNCTION form — the object
        // form hard-fails the Rolldown build ("Invalid type: Expected Function
        // but received Object"). Keep phaser split into its own chunk so the
        // dynamic import("phaser") boundary stays off the entry bundle (HD-09).
        // Rolldown's native successor API is `advancedChunks`; we intentionally
        // stay on the function form here for a minimal bump-only diff.
        manualChunks(id: string) {
          if (id.includes("node_modules/phaser/")) return "phaser";
        },
      },
    },
  },
});
