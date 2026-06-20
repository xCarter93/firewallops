import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Client } from "@colyseus/sdk";
import type { Server } from "colyseus";
import { buildServer } from "../src/index.js";

/**
 * Wave-0 IN-PROCESS decorator-boot smoke (Pitfall 1 — the keystone risk).
 *
 * The Colyseus `@type()` schema encoder crashes at the FIRST full-state send if
 * the decorator tsconfig (experimentalDecorators + useDefineForClassFields:false)
 * is not in effect — and `tsc --noEmit` does NOT catch it. This test boots the
 * EXACT production wiring (`buildServer()`), connects a REAL `@colyseus/sdk`
 * client, `joinOrCreate("match")`, and awaits the first full state — proving a
 * real full-state encode/send happens WITHOUT the crash.
 *
 * The crash is described by CONCEPT (decorator/metadata) in this comment and the
 * assertion is on the ABSENCE of a throw + a non-empty state — NOT on a literal
 * error string (so a later negative grep cannot trip on it).
 *
 * In-memory path only: no REDIS_URL / CONVEX_URL / REQUIRE_DEPLOY_DEPS, so the
 * boot checks self-skip and no external service is touched.
 */
describe("boot-smoke: real server boot + real join → full state (Pitfall 1)", () => {
  let gameServer: Server;
  let client: Client;
  let port: number;
  const ENV_KEYS = [
    "REDIS_URL",
    "CONVEX_URL",
    "REQUIRE_DEPLOY_DEPS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    port = 2700 + Math.floor(Math.random() * 200);
    gameServer = buildServer();
    await gameServer.listen(port, "127.0.0.1");
    client = new Client(`ws://127.0.0.1:${port}`);
  }, 20_000);

  afterAll(async () => {
    try {
      await gameServer?.gracefullyShutdown(false);
    } catch {
      /* ignore teardown errors */
    }
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("joinOrCreate('match') receives a non-empty MatchState with no encoder crash", async () => {
    const room = await client.joinOrCreate("match", {});

    // Await the first full-state patch (the moment the encoder runs).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for full state")),
        8_000,
      );
      room.onStateChange.once((state) => {
        clearTimeout(t);
        // The joining client is seated → at least one mobile in the synced map.
        expect(state).toBeDefined();
        expect(state.mobiles.size).toBeGreaterThanOrEqual(1);
        resolve();
      });
    });

    await room.leave();
  }, 15_000);
});
