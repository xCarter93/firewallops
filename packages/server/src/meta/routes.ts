/**
 * Meta API route registration — the EXPORTED, unit-testable seam.
 *
 * The bare handlers (`loadoutHandler`, `matchResultsHandler`) are typed
 * structurally so they can be exercised with fake req/res objects WITHOUT
 * booting Express or a live server. `registerMetaRoutes` wires them onto a real
 * Express app, delegating to the same handlers so the route logic is covered by
 * the headless unit test (Codex MEDIUM: export reusable route registration so
 * stub logic is testable without booting a server).
 */
import express from "express";
import type { Application } from "express";
import { getLoadout } from "./loadout.js";
import { recordMatchResult } from "./results.js";

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
 * Bare match-results handler — structural req/res so it is testable without
 * Express. Accepts any body, records (no-op), and 200s.
 */
export function matchResultsHandler(
  req: { body: unknown },
  res: { sendStatus: (code: number) => void },
): void {
  recordMatchResult(req.body as { winnerTeam: number });
  res.sendStatus(200);
}

/**
 * Wire the `/internal/*` Meta API routes onto an Express app. Both routes
 * delegate to the bare handlers above so the route logic is shared with the
 * unit test.
 */
export function registerMetaRoutes(app: Application): void {
  app.get("/internal/loadout/:accountId", (req, res) =>
    loadoutHandler({ params: { accountId: req.params.accountId } }, res),
  );
  app.post("/internal/match-results", express.json(), (req, res) =>
    matchResultsHandler({ body: req.body }, res),
  );
}
