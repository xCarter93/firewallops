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
import { clerkWebhookHandler } from "./webhooks.js";
import { verifyClerk } from "../auth/clerk.js";
import { getConvex, api } from "./convexClient.js";

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

  // ── RAW-BODY ROUTE FIRST (Pitfall 3 / T-05-AUTH-01) ──────────────────────
  // The Clerk webhook MUST be registered BEFORE any `express.json()` route so no
  // json parser ever sees its body: Svix verifies the EXACT raw bytes Clerk
  // signed, and a re-serialized json body would fail HMAC. `express.raw` keeps
  // `req.body` as a Buffer of the original bytes. This line precedes ALL
  // `express.json()` registrations below (route-order invariant).
  app.post(
    "/internal/webhooks/clerk",
    express.raw({ type: "application/json" }),
    (req, res) =>
      clerkWebhookHandler({ headers: req.headers, body: req.body }, res),
  );

  app.get("/internal/loadout/:accountId", (req, res) =>
    loadoutHandler({ params: { accountId: req.params.accountId } }, res),
  );

  // ── Bearer-verified profile read/write (AUTH-04, Blocker 1 / T-05-AUTH-02) ─
  // The public game handle = `accounts.display_name`. Both routes require a valid
  // Clerk Bearer token; the accountId comes from the verified `sub`, NEVER the
  // request body, so a caller cannot read/write another player's profile.
  app.get("/internal/profile", express.json(), (req, res) => {
    void (async () => {
      const accountId = await bearerAccountId(req, res);
      if (!accountId) return;
      const row = await getConvex().query(api.accounts.getByAuthUserId, {
        authUserId: accountId,
      });
      res.status(200).json(row ?? null);
    })();
  });

  app.post("/internal/profile", express.json(), (req, res) => {
    void (async () => {
      const accountId = await bearerAccountId(req, res);
      if (!accountId) return;
      const displayName = (req.body as { displayName?: unknown })?.displayName;
      if (typeof displayName !== "string" || displayName.length === 0) {
        res.status(400).end();
        return;
      }
      await getConvex().mutation(api.accounts.setDisplayName, {
        authUserId: accountId,
        displayName,
      });
      res.status(200).end();
    })();
  });

  app.post("/internal/match-results", express.json(), (req, res) =>
    matchResultsHandler({ headers: req.headers, body: req.body }, res),
  );
}

/**
 * Resolve the verified Clerk accountId (`sub`) from the `Authorization: Bearer`
 * header via the SHARED `verifyClerk` wrapper (AUTH-03 — one token, two
 * consumers). On a missing/invalid token, responds 401 and returns null so the
 * caller short-circuits. The accountId is the verified subject, never body input.
 */
async function bearerAccountId(
  req: { headers: Record<string, unknown> },
  res: {
    status: (code: number) => { end: () => void; json: (b: unknown) => void };
  },
): Promise<string | null> {
  const auth = req.headers["authorization"];
  const header = typeof auth === "string" ? auth : "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).end();
    return null;
  }
  try {
    const { accountId } = await verifyClerk(token);
    return accountId;
  } catch {
    res.status(401).end();
    return null;
  }
}
