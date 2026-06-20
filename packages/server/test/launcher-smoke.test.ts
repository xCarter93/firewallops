import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@colyseus/sdk";

/**
 * Wave-0 LAUNCHER-PARITY smoke (Codex concern #6 — Pitfall 1, container parity).
 *
 * boot-smoke.test.ts boots the server IN-PROCESS via `buildServer()`. But the
 * decorator/tsconfig crash (Pitfall 1) depends on the CWD `tsx` discovers the
 * tsconfig from — so the in-process test (which already runs under the server's
 * tsconfig via Vitest) cannot reproduce a wrong-cwd launch. This test spawns the
 * server the way the CONTAINER does: `pnpm start` (= `tsx src/index.ts`) with
 * cwd = packages/server (mirrors the Dockerfile WORKDIR), then connects a REAL
 * client and joins — proving the real launcher entrypoint boots + encodes full
 * state without the crash.
 *
 * In-memory path only (no REDIS_URL/CONVEX_URL/REQUIRE_DEPLOY_DEPS). Generous
 * timeout because it cold-starts a child `tsx` process.
 */
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, ".."); // packages/server

describe("launcher-smoke: pnpm start (cwd packages/server) boots + serves (concern #6)", () => {
  let child: ChildProcess;
  let client: Client | undefined;
  const port = 2900 + Math.floor(Math.random() * 200);

  beforeAll(async () => {
    child = spawn("pnpm", ["start"], {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        BIND_HOST: "127.0.0.1",
        REDIS_URL: undefined,
        CONVEX_URL: undefined,
        REQUIRE_DEPLOY_DEPS: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the boot log (the server prints its listen line) or a port-open.
    await new Promise<void>((resolveReady, reject) => {
      const t = setTimeout(
        () => reject(new Error("server did not boot in time")),
        25_000,
      );
      const onData = (buf: Buffer) => {
        const s = buf.toString();
        if (/listening/i.test(s) || s.includes(String(port))) {
          clearTimeout(t);
          resolveReady();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(t);
        reject(new Error(`server exited early (code ${code ?? "?"})`));
      });
    });
  }, 35_000);

  afterAll(() => {
    // The room is left in the test body; just stop the spawned child.
    void client;
    child?.kill("SIGTERM");
  });

  it("a real client joins 'match' against the spawned server and gets full state", async () => {
    client = new Client(`ws://127.0.0.1:${port}`);
    const room = await client.joinOrCreate("match", {});

    await new Promise<void>((resolveState, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for full state")),
        10_000,
      );
      room.onStateChange.once((state) => {
        clearTimeout(t);
        expect(state).toBeDefined();
        expect(state.mobiles.size).toBeGreaterThanOrEqual(1);
        resolveState();
      });
    });

    await room.leave();
  }, 20_000);
});
