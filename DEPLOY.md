# Deploy Runbook — Firewall Ops (Railway + Convex + Vercel)

This is the hands-on manual deploy runbook for the Phase-4 thin real-deployment slice:
a static Phaser client on **Vercel** (CDN) connecting over `wss://` to a persistent
**Colyseus + Meta-API** container on **Railway**, with **Railway managed Redis**
(Colyseus presence/driver) and a **Convex** persistence deployment (skeleton `accounts`
schema + boot health-check).

The stateful/stateless split: Colyseus is the stateful piece (persistent container, **exactly one replica**);
the client is the stateless piece (static bundle on a CDN); Redis + Convex are the connected data stores.

> **Deploy ORDER (do not reorder):**
> Convex (`npx convex deploy`) → Railway project + repo → managed Redis → pin `numReplicas=1` + drain envs → server variables → confirm `*.up.railway.app` domain → Vercel (`VITE_SERVER_URL` + `VITE_NETWORKED=1`) → client deploy → post-deploy WS-join smoke check → two-network play test.
>
> Convex is **first** so its `CONVEX_URL` exists before the server boots.

---

## 0. Prerequisites

- **Railway account** (Hobby plan) and the `railway` CLI: `npm i -g @railway/cli` then `railway login`. (CLI is optional — the dashboard flow works too.)
- **Convex** account on a paid (Pro) plan, and the Convex CLI (run via `npx convex` from the package — no global install needed).
- **Vercel** account.
- **Docker is NOT needed locally** — Railway builds the `packages/server/Dockerfile` remotely.
- A clean working tree on the branch you intend to deploy (Railway auto-builds on push when the repo is connected).

---

## 1. Convex FIRST — deploy the schema, record `CONVEX_URL`

The server needs `CONVEX_URL` to exist before it boots, so deploy Convex first.

1. **Generate a Production deploy key:** Convex Dashboard → your project → **Deployment Settings → General → Production deploy key**. Copy it.
2. **Deploy FROM the Convex package** (Plan 01 moved Convex into a dedicated `@firewallops/convex` workspace package — the Convex CLI reads the `package.json` at its *cwd*, so a repo-root invocation fails with `add convex to your package.json dependencies`):

   ```bash
   cd packages/convex
   CONVEX_DEPLOY_KEY=<prod-deploy-key> npx convex deploy
   ```

   Equivalently from the repo root:

   ```bash
   CONVEX_DEPLOY_KEY=<prod-deploy-key> pnpm --filter @firewallops/convex exec convex deploy
   ```

3. **Record the printed production `CONVEX_URL`** (looks like `https://<prod>.convex.cloud`). You will set this as a Railway *server* variable in step 4.
4. **Commit any regenerated codegen.** `npx convex deploy` regenerates `packages/convex/convex/_generated/` from the real backend. Plan 01 shipped a hand-written `_generated/` stub (codegen needs an authed deployment); this deploy step replaces it with the **real** generated files. Commit the regenerated `packages/convex/convex/_generated/` so the deployed Docker image carries real codegen:

   ```bash
   git add packages/convex/convex/_generated
   git commit -m "chore(04-05): real Convex codegen from convex deploy"
   ```

5. **Confirm the schema deployed:** Convex Dashboard → **Data** → the `accounts` table should appear.

> **Secret discipline (concern #7):** `CONVEX_DEPLOY_KEY` is high-privilege and is used **ONLY** in this `npx convex deploy` step. It is **NOT** a Railway server variable — the long-running server needs only the public `CONVEX_URL` for its boot health-check.

---

## 2. Railway project + server service

1. **Create a Railway project** and **connect the GitHub repo** (Railway auto-builds the Dockerfile on each push — the lowest-friction path). Alternatively use `railway up` from the repo root (you keep manual timing control over deploys).
2. **Leave Root Directory UNSET** — the build context must be the **repo root** so the `workspace:*` deps (`@shared/sim`, `@firewallops/convex`) resolve during `pnpm install --frozen-lockfile`.
3. **Dockerfile path is owned by `railway.json`.** The `dockerfilePath: "packages/server/Dockerfile"` field in `railway.json` (committed in Plan 04) is the **single authoritative** mechanism.
   - **Do NOT set `RAILWAY_DOCKERFILE_PATH`** (concern #13) — it is a fallback/override only; `railway.json` `dockerfilePath` already points at the Dockerfile.
4. **Pick a region** nearest you + your second playtester (US-West / US-East / EU-West / Singapore). Confirm region selection is available on the Hobby plan at setup.
5. **PIN the server service to exactly one replica:** set **`numReplicas = 1`** (review C3). `railway.json` already declares `numReplicas: 1`; confirm the service Settings show ONE replica. (If Railway rejected the JSON field, set it here in the service settings.)

### 2a. SINGLE-INSTANCE GUARDRAIL (review C3 — keep verbatim)

> **Railway runs EXACTLY ONE replica of the game server. To handle more load, scale UP (more CPU/RAM on the single instance) — NEVER add replicas. Railway has no sticky sessions, so a second replica would break Colyseus seat-reservation and room routing (clients would be load-balanced to a node that doesn't hold their room). Horizontal scaling is a pre-scale track item, gated on multi-node matchmaking — see HOSTING-SCALING §9.**

---

## 3. Provision the managed Redis

In the Railway project: **`+ New` → Database → Redis** (the one-click managed Redis template — a real TCP Redis, official image, supports pub/sub + `BRPOP` + `MULTI`, ioredis-compatible).

This adds a Redis service to the project that exposes `REDIS_URL` etc. on Railway's private network. You will reference it from the server service in the next step.

> Use the **private** reference (`${{ Redis.REDIS_URL }}`), not the public TCP-proxy URL — the private URL avoids egress and stays on the internal network.

---

## 4. Set the server-service variables

On the **server service** → **Variables** (or `railway variables`). Set ALL of these:

| Variable | Value | Why |
| --- | --- | --- |
| `REDIS_URL` | `${{ Redis.REDIS_URL }}` | Railway reference variable → the managed Redis service's **private** URL (Colyseus presence/driver). Set verbatim — **no `?family=6`** (Railway environments are dual-stack). |
| `CONVEX_URL` | `https://<prod>.convex.cloud` (from step 1) | The ONLY thing the long-running server needs from Convex (public boot query). |
| `CORS_ORIGINS` | `https://<app>.vercel.app` | The Vercel production origin allowed on the `/internal` Meta-API. See the **CORS-ordering note** (step 4a) — this URL doesn't exist until the Vercel project is created. |
| `RESULTS_SERVICE_SECRET` | `<generated secret>` | Gates `POST /internal/match-results` so the results write path is **not open** (review H7). Use the same value on any service caller that posts results. |
| `REQUIRE_DEPLOY_DEPS` | `true` | Deploy-mode guard (concern #5): the server **fails boot fast** if `REDIS_URL` or `CONVEX_URL` is missing — no silent in-memory fallback in production. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` (or a suitable window) | Graceful drain (review H2): on deploy/restart, gives `MatchRoom.onBeforeShutdown` time to drain so a live match isn't silently killed. |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `<overlap>` | Graceful drain (review H2): brings the new instance up **before** the old drains, so there's no gap. |

**Do NOT set:**

- **`CONVEX_DEPLOY_KEY`** as a server variable (concern #7) — it lives only in the `npx convex deploy` step (step 1).
- **`RAILWAY_DOCKERFILE_PATH`** (concern #13) — `railway.json` `dockerfilePath` is authoritative.
- **`BIND_HOST`** — the server binds dual-stack `::` by default (Plan 03 hard-default; it does **not** read `HOSTNAME`, concern #4). Leave it unset.

After setting the variables, trigger a (re)deploy so the server picks them up.

### 4a. CORS ORDERING (concern #10)

`CORS_ORIGINS` needs the Vercel production URL, which does not exist until the Vercel project is created (step 6). Resolve the loop with ONE of:

- **Option A (recommended):** create the Vercel project FIRST — do step 6 up to "get the `*.vercel.app` URL" (with a temporary placeholder `VITE_SERVER_URL`), copy `https://<app>.vercel.app`, THEN set `CORS_ORIGINS` and (re)deploy the server; finally finish step 6 with the real `VITE_SERVER_URL` and rebuild the client.
- **Option B:** set `CORS_ORIGINS` to a placeholder now, finish steps 5–6 to learn the real Vercel URL, then UPDATE `CORS_ORIGINS` and REDEPLOY the server.

---

## 5. Confirm the public domain

Railway issues a `<service>.up.railway.app` domain for the server service (instant, free SSL, WebSocket `Upgrade` supported). This `*.up.railway.app` host is the `wss://` endpoint the client connects to.

**Verify the boot health-check (DEPLOY-04):** open Railway → server service → **Deploy logs** (or `railway logs`). Confirm the honest per-check summary shows BOTH checks ran and passed:

```
boot checks: redis=ok convex=ok
```

- A `skipped` for either means its variable is missing — but with `REQUIRE_DEPLOY_DEPS=true` the boot instead **fails fast** (the intended guard). If boot fails: confirm the server binds `::` (Plan 03 `BIND_HOST` default), `REDIS_URL` resolves to the `${{ Redis.REDIS_URL }}` private reference, `CONVEX_URL` is set, and the Redis service is up.
- Confirm the service shows **exactly ONE replica** (review C3).

---

## 6. Vercel client — `VITE_SERVER_URL` + `VITE_NETWORKED=1`

1. **Vercel Dashboard → New Project → import the repo → Root Directory = `packages/client`** (Vite is auto-detected).
2. Set **TWO** Environment Variables, **Production scope, BEFORE the build** (Vite inlines them at build time — Pitfall 4 — so setting them after a build has no effect):

   | Variable | Value | Why |
   | --- | --- | --- |
   | `VITE_SERVER_URL` | `wss://<service>.up.railway.app` | The Railway server domain (step 5). Use **`wss://`**, not `ws://` (Pitfall 5). A missing/empty value makes the production bundle throw (Plan 02 concern #11). |
   | `VITE_NETWORKED` | `1` | review C2 — so the deployed bundle runs the **real networked match**, NOT the documented-non-functional hotseat dev sandbox. |

3. **Deploy.** Record the production `*.vercel.app` URL. Subsequent `git push` auto-rebuilds the client.

> If you used CORS-ordering Option A, this is where you copy the `*.vercel.app` URL back into the Railway `CORS_ORIGINS` variable and redeploy the server, then rebuild the client with the real `VITE_SERVER_URL`.

---

## 7. Operational notes

- A `git push` to the connected branch **auto-redeploys**. With the H2 drain envs set (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` + `OVERLAP_SECONDS`), the old instance **drains** rather than instantly killing a live match — but **reconnection is Phase 5**, so still **avoid deploying mid-playtest**. With `railway up` you retain manual timing control over when a deploy lands.
- Railway is **always-on by default** — serverless/sleep is NOT enabled (evicting a live in-RAM match is unsafe until Phase-5 reconnection).
- Redis here is a **rebuildable cache** (room registry + seat reservations), not source-of-truth — a single managed instance is fine for the playtest.

---

## 8. POST-DEPLOY WS-JOIN SMOKE CHECK (review C2)

Run this **before** the two-human test — it proves the **deployed** build actually joins a real networked room (not just a local check). This is the C2 gate.

1. Open `https://<app>.vercel.app` in a **clean / incognito** browser with **no local dev server running**.
2. **DevTools → Console:** the connect URL is `wss://<service>.up.railway.app` (NOT `localhost`) — proves `VITE_SERVER_URL` was injected at build time (Pitfall 5: `wss` not `ws`).
3. **DevTools → Network → WS:** the WebSocket shows **OPEN** and a `joinOrCreate("match")` round-trip — proves `VITE_NETWORKED=1` ran the **networked** path, not the hotseat sandbox.
4. **Railway → Deploy logs:** the server logs the `onJoin` for that session, and the boot summary shows `boot checks: redis=ok convex=ok`.

If the WS connects to `localhost` / is undefined, or no `joinOrCreate("match")` round-trip happens (the build ran hotseat): re-check that BOTH Vercel envs were set **before** the build, then redeploy the client.

> Optional CLI variant: a tiny `@colyseus/sdk` script that `joinOrCreate("match")` against `wss://<service>.up.railway.app` and asserts a state message. The browser-DevTools form above is sufficient and matches how players actually reach the game.

---

## 9. DEPLOY-03 two-network end-to-end verification

Two people on two **different** networks play a full networked match against the deployed stack.

**Steps:**

1. **You** open `https://<app>.vercel.app` on your home network → it connects `wss://<service>.up.railway.app` and auto-joins the `"match"` room.
2. A **SECOND person** opens the same URL on a **DIFFERENT network** (mobile hotspot / different ISP / different city) → joins the same `"match"` room.
3. Play a **FULL match**: aim, fire, terrain carve, turn timer, until the match-end banner (win/draw). Terrain carving + damage applying confirms the deployed networked build is functional (review C2).
4. **WS-IDLE CHECK (Railway edge-proxy persistence caveat):** at some point **idle through a full turn** (do not act for the entire turn timer) and confirm the WebSocket stays **OPEN** — no disconnect/reconnect in DevTools → Network → WS, and the match continues normally after the idle turn. Colyseus heartbeats should keep it live; **if the WS drops on idle**, the documented fallback is Railway's TCP Proxy.
5. Both confirm: shots resolve identically, terrain stays in sync, turn order is correct, the match ends cleanly.

**Server-side confirmation** (Railway → Deploy logs, or `railway logs`):

- Two **distinct remote IPs** in the **same room id** (two networks).
- RedisPresence/RedisDriver activity at boot (the managed Redis is in the path, not the in-memory fallback).
- The boot summary `boot checks: redis=ok convex=ok` (concern #5).

**Pass criteria:** two distinct client IPs in the same room id; a full match completes with synced terrain + correct match-end; the WS survives an idle turn; the boot log shows `redis=ok convex=ok` (not skipped).

---

## Appendix — concrete values reference

| Thing | Value |
| --- | --- |
| Server Dockerfile | `packages/server/Dockerfile` (build context = repo root; `railway.json` `dockerfilePath`) |
| Server port | `2567` (Dockerfile `EXPOSE 2567` / `ENV PORT=2567`; `/health` healthcheck) |
| Redis reference | `${{ Redis.REDIS_URL }}` (private network) |
| Server domain | `wss://<service>.up.railway.app` |
| Client root dir (Vercel) | `packages/client` |
| Required Vercel envs | `VITE_SERVER_URL`, `VITE_NETWORKED=1` |
| Required Railway server envs | `REDIS_URL`, `CONVEX_URL`, `CORS_ORIGINS`, `RESULTS_SERVICE_SECRET`, `REQUIRE_DEPLOY_DEPS=true`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` |
| NEVER a server env | `CONVEX_DEPLOY_KEY` (concern #7), `RAILWAY_DOCKERFILE_PATH` (concern #13) |

`<placeholders>`: `<prod>` (Convex prod slug), `<service>` (Railway service slug), `<app>` (Vercel app slug), `<generated secret>` (the `RESULTS_SERVICE_SECRET` value), `<overlap>` (overlap-seconds window).
