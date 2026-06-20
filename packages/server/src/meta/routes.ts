/**
 * Meta API route registration — the EXPORTED, unit-testable seam.
 *
 * The bare handlers (`loadoutHandler`, `matchResultsHandler`) are typed
 * structurally so they can be exercised with fake req/res objects WITHOUT
 * booting Express or a live server. `registerMetaRoutes` wires them onto a real
 * Express app, delegating to the same handlers so the route logic is covered by
 * the headless unit test (Codex MEDIUM: export reusable route registration so
 * stub logic is testable without booting a server).
 *
 * SECURITY (Plan 04-03):
 *   - CORS allowlist on `/internal` ONLY (RESEARCH Pattern 5) — the Vercel origin
 *     from `CORS_ORIGINS`; origin `false` (no cross-origin) when unset (local
 *     dev). The Colyseus WS transport is NOT CORS-wrapped (browsers do not
 *     preflight WS handshakes — RESEARCH anti-pattern).
 *   - `POST /internal/match-results` is no longer an open write path (review H7):
 *     it requires a `RESULTS_SERVICE_SECRET` shared-secret header + Zod
 *     validation (`matchResultSchema`) + `resultId` idempotency BEFORE the
 *     (still no-op) `recordMatchResult`. The loadout READ seam stays an
 *     unauthenticated defaults read (no secret needed this phase).
 */
import express from "express";
import type { Application } from "express";
import cors from "cors";
import { getLoadout } from "./loadout.js";
import { recordMatchResult } from "./results.js";
import { matchResultSchema } from "../match/messageSchemas.js";

/**
 * Bare loadout handler — structural req/res so it is testable without Express.
 */
export function loadoutHandler(
  req: { params: { accountId: string } },
  res: { json: (body: unknown) => void },
): void {
  res.json(getLoadout(req.params.accountId));
}

/**
 * In-memory idempotency ledger for `POST /internal/match-results` (review H7).
 *
 * A `resultId` already seen is a no-op replay. In-memory is acceptable for the
 * single always-on instance this phase ships; durable idempotency lands with the
 * Phase-5 Convex persistence. Bounded with a soft cap so a long-running process
 * cannot grow it without limit.
 */
const SEEN_RESULT_IDS = new Set<string>();
const SEEN_CAP = 10_000;

/** Test-only: clear the idempotency ledger between cases. */
export function __resetResultsIdempotency(): void {
  SEEN_RESULT_IDS.clear();
}

/**
 * Hardened match-results handler — structural req/res so it is testable without
 * Express (review H7). Order: service-auth → Zod parse → idempotency → record.
 *   - Missing/wrong `x-service-secret` (when `RESULTS_SERVICE_SECRET` is set) →
 *     403, NOT recorded.
 *   - Body failing `matchResultSchema` → 400, NOT recorded.
 *   - A `resultId` already seen → 200 no-op (not double-recorded).
 *   - Otherwise → record once, 200.
 */
export function matchResultsHandler(
  req: { headers: Record<string, unknown>; body: unknown },
  res: {
    status: (code: number) => { json: (b: unknown) => void; send: (b?: unknown) => void; end: () => void };
    sendStatus: (code: number) => void;
  },
): void {
  // 1. Service auth — constant shared secret. This endpoint is service-to-service
  //    (the authoritative room writes in-process; external callers must present
  //    the secret). A missing/wrong header never records.
  const expected = process.env.RESULTS_SERVICE_SECRET;
  if (expected) {
    const provided = req.headers["x-service-secret"];
    if (typeof provided !== "string" || provided !== expected) {
      res.status(403).end();
      return;
    }
  }

  // 2. Zod validation — an invalid body is rejected before any record.
  const parsed = matchResultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).end();
    return;
  }

  // 3. Idempotency — a repeated resultId is a no-op 200 (not double-recorded).
  if (SEEN_RESULT_IDS.has(parsed.data.resultId)) {
    res.status(200).end();
    return;
  }
  if (SEEN_RESULT_IDS.size >= SEEN_CAP) {
    // Soft cap: drop the oldest-inserted id (insertion order) to bound memory.
    const oldest = SEEN_RESULT_IDS.values().next().value;
    if (oldest !== undefined) SEEN_RESULT_IDS.delete(oldest);
  }
  SEEN_RESULT_IDS.add(parsed.data.resultId);

  // 4. Record (still a no-op stub — Phase-5 persistence) + 200.
  recordMatchResult(parsed.data);
  res.status(200).end();
}

/**
 * Wire the `/internal/*` Meta API routes onto an Express app. CORS is applied to
 * the `/internal` path FIRST (allowlist from `CORS_ORIGINS`), then the routes.
 * Both routes delegate to the bare handlers above so the route logic is shared
 * with the unit test.
 */
export function registerMetaRoutes(app: Application): void {
  const allowed = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // CORS on /internal ONLY (RESEARCH Pattern 5). When CORS_ORIGINS is unset
  // (local dev), `origin: false` disables cross-origin. The WS transport is
  // intentionally untouched (WS handshakes are not CORS-preflighted).
  app.use("/internal", cors({ origin: allowed.length ? allowed : false }));

  app.get("/internal/loadout/:accountId", (req, res) =>
    loadoutHandler({ params: { accountId: req.params.accountId } }, res),
  );
  app.post("/internal/match-results", express.json(), (req, res) =>
    matchResultsHandler({ headers: req.headers, body: req.body }, res),
  );
}
