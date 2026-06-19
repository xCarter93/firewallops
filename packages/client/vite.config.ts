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
        manualChunks: {
          phaser: ["phaser"],
        },
      },
    },
  },
});
