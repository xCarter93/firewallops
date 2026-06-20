import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

/**
 * Wave-0 match-results auth/validation/idempotency test (review H7).
 *
 * Today `POST /internal/match-results` accepts ANY body unauthenticated — the
 * OPEN write path H7 forbids. This locks the hardened handler:
 *   (a) NO/incorrect service-auth header → REJECTED (401/403), recordMatchResult
 *       NOT called.
 *   (b) authed + INVALID body (fails the Zod schema, e.g. missing winnerTeam) →
 *       REJECTED (400), NOT recorded.
 *   (c) authed + VALID body → accepted (200), recorded ONCE.
 *   (d) IDEMPOTENCY: a second authed request with the SAME resultId → does NOT
 *       double-record (recorded count stays 1, duplicate is a no-op 200).
 *
 * Exercised HEADLESSLY against the exported `matchResultsHandler` (structural
 * req/res), the established meta-routes test convention. `recordMatchResult` is
 * spied to assert the recorded count.
 */

const recordSpy = vi.fn<(p: { winnerTeam: number; resultId: string }) => void>();
vi.mock("../src/meta/results.js", () => ({
  recordMatchResult: (p: { winnerTeam: number; resultId: string }) =>
    recordSpy(p),
}));

import {
  matchResultsHandler,
  __resetResultsIdempotency,
} from "../src/meta/routes.js";

const SECRET = "test-service-secret";

/** Minimal structural res capturing status + sent code. */
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

describe("results-auth: POST /internal/match-results gating (review H7)", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.RESULTS_SERVICE_SECRET;
    process.env.RESULTS_SERVICE_SECRET = SECRET;
    recordSpy.mockReset();
    __resetResultsIdempotency();
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.RESULTS_SERVICE_SECRET;
    else process.env.RESULTS_SERVICE_SECRET = savedSecret;
  });

  it("(a) missing service-auth header → rejected, NOT recorded", () => {
    const { res, captured } = makeRes();
    matchResultsHandler(
      { headers: {}, body: { winnerTeam: 0, resultId: "r1" } },
      res,
    );
    expect([401, 403]).toContain(captured.status);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("(a') wrong service-auth header → rejected, NOT recorded", () => {
    const { res, captured } = makeRes();
    matchResultsHandler(
      {
        headers: { "x-service-secret": "wrong" },
        body: { winnerTeam: 0, resultId: "r1" },
      },
      res,
    );
    expect([401, 403]).toContain(captured.status);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("(b) authed + invalid body (missing winnerTeam) → 400, NOT recorded", () => {
    const { res, captured } = makeRes();
    matchResultsHandler(
      {
        headers: { "x-service-secret": SECRET },
        body: { resultId: "r1" }, // winnerTeam missing → fails Zod
      },
      res,
    );
    expect(captured.status).toBe(400);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("(c) authed + valid body → 200, recorded once", () => {
    const { res, captured } = makeRes();
    matchResultsHandler(
      {
        headers: { "x-service-secret": SECRET },
        body: { winnerTeam: 1, resultId: "r-valid" },
      },
      res,
    );
    expect(captured.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledOnce();
  });

  it("(d) duplicate resultId → not double-recorded (count stays 1, no-op 200)", () => {
    const body = { winnerTeam: 1, resultId: "dup-1" };
    const first = makeRes();
    matchResultsHandler(
      { headers: { "x-service-secret": SECRET }, body },
      first.res,
    );
    expect(first.captured.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledOnce();

    const second = makeRes();
    matchResultsHandler(
      { headers: { "x-service-secret": SECRET }, body },
      second.res,
    );
    expect(second.captured.status).toBe(200); // idempotent no-op
    expect(recordSpy).toHaveBeenCalledOnce(); // STILL once — not double-recorded
  });
});
