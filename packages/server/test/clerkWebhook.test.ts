import { describe, it, expect, vi } from "vitest";

/**
 * RED until plan 03 — Wave-0 contract scaffold (05-VALIDATION.md); dynamic
 * import keeps collection/typecheck green.
 *
 * AUTH-04: pins the Clerk webhook handler contract — bad svix signature → 400
 * and provision NOT called; a valid `user.created` event → provision called with
 * the user id and res status 200 — BEFORE plan 03 writes `src/meta/webhooks.js`.
 * The handler is reached ONLY via a dynamic `await import("../src/meta/webhooks.js")`
 * INSIDE the test body (never a top-level static import), with the future module
 * path under `@ts-expect-error` so `tsc` stays green until the file exists
 * (Blocker 4). The `await import` REJECTS (module not found) until plan 03 lands,
 * so each test is meaningfully RED for the RIGHT reason — the handler is not
 * built yet. RED→GREEN handoff: when plan 03 creates `src/meta/webhooks.js`, it
 * MUST delete the two `@ts-expect-error` lines below (the suppressed error
 * vanishes, so the directive would otherwise become an "unused expectation").
 *
 * `svix` (not installed until plan 03) is mocked via `vi.mock` + a `vi.hoisted`
 * Webhook handle. `vi.mock(specifier, factory)` takes the specifier as a plain
 * string so `tsc` does NOT resolve it (no TS2307 for the absent package), and we
 * never `import` from `svix` directly — keeping typecheck green.
 */

const { verifyMock, WebhookMock } = vi.hoisted(() => {
  const verifyMock = vi.fn();
  return {
    verifyMock,
    WebhookMock: vi.fn().mockImplementation(() => ({ verify: verifyMock })),
  };
});
vi.mock("svix", () => ({ Webhook: WebhookMock }));

/** Minimal structural res capturing the status code (mirrors results-auth). */
function makeRes() {
  const captured: { status?: number } = {};
  return {
    res: {
      status(code: number) {
        captured.status = code;
        return {
          json: () => undefined,
          send: () => undefined,
          end: () => undefined,
        };
      },
      sendStatus(code: number) {
        captured.status = code;
      },
    },
    captured,
  };
}

/** The handler contract plan 03 must satisfy (pinned here). */
type ClerkWebhookHandler = (
  req: { headers: Record<string, string>; body: unknown },
  res: ReturnType<typeof makeRes>["res"],
  provision: (userId: string) => void,
) => void;

describe("clerk webhook", () => {
  it("bad svix signature → res 400 and provision NOT called (AUTH-04)", async () => {
    verifyMock.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const provision = vi.fn();
    const { res, captured } = makeRes();

    // @ts-expect-error src/meta/webhooks.js is created in plan 03 (Blocker 4: dynamic; delete on GREEN).
    const mod = await import("../src/meta/webhooks.js");
    const clerkWebhookHandler = mod.clerkWebhookHandler as ClerkWebhookHandler;

    clerkWebhookHandler(
      { headers: { "svix-signature": "v1,bad" }, body: "{}" },
      res,
      provision,
    );

    expect(captured.status).toBe(400);
    expect(provision).not.toHaveBeenCalled();
  });

  it("valid user.created → provision called with the user id and res 200 (AUTH-04)", async () => {
    verifyMock.mockReturnValue({
      type: "user.created",
      data: { id: "user_123" },
    });
    const provision = vi.fn();
    const { res, captured } = makeRes();

    // @ts-expect-error src/meta/webhooks.js is created in plan 03 (Blocker 4: dynamic; delete on GREEN).
    const mod = await import("../src/meta/webhooks.js");
    const clerkWebhookHandler = mod.clerkWebhookHandler as ClerkWebhookHandler;

    clerkWebhookHandler(
      { headers: { "svix-signature": "v1,good" }, body: "{}" },
      res,
      provision,
    );

    expect(provision).toHaveBeenCalledWith("user_123");
    expect(captured.status).toBe(200);
  });
});
