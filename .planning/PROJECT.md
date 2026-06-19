# FirewallOps

## What This Is

FirewallOps is a web-first, turn-based artillery game — a tech-themed reskin of Gunbound. Players pilot mechs that take turns adjusting angle, power, and item, then fire exploit-projectiles at each other across destructible datacenter / circuit-board terrain, with wind nudging every shot. It is the proven Gunbound/Worms loop rendered in a clean-vector tech aesthetic and played in the browser, with authoritative networked multiplayer, lobby/rooms, reconnection, and account-backed profiles. The reskin is aesthetic, not mechanical: the underlying ballistics, turn rules, and netcode are the genre originals.

## Core Value

The core artillery loop must feel fun and the authoritative netcode must hold up with real players. If aiming an exploit into destructible terrain across wind — and firing it — doesn't feel good, nothing else matters. Everything in v0 exists to answer those two questions.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — greenfield. Ship to validate.)

### Active

<!-- v0 scope. All are hypotheses until shipped and validated. -->

- [ ] **Shared sim (`@shared/sim`)** — ballistics (wind/gravity, fixed-step integration), 1-bit terrain collision mask + crater carving, shot resolution → blast damage. Pure, engine-free, imported by both client and server.
- [ ] **Hotseat match (the fun gate)** — one map, one mech, 2 players same-screen: aim UI (angle/power), fire, animate arc + impact, carve terrain, apply damage, win check. Local, no server. This is the go/no-go on fun.
- [ ] **Authoritative networked match** — server runs the sim, broadcasts `shotResult`; turn state machine (WAITING→TURN_START→AIMING→RESOLVING→RESULTS), active-player gate, turn timer/auto-forfeit, synced MatchState schema.
- [ ] **Destructible terrain sync** — carve-replay from server's impact broadcast + RLE terrain snapshot on join/reconnect.
- [ ] **Wind + items** — per-turn wind; 1–2 exploit items (e.g. single packet vs. forked/dual exploit) to make item choice real.
- [ ] **Solo mode** — free-for-all / last-mech-standing, 2–4 players per match.
- [ ] **Lobby / rooms / matchmaking** — channel→room→match, room listing, room master sets map + ready toggles, auto-lock when full, matchmaking metadata reflects room state.
- [ ] **Reconnection** — `onDrop` / `allowReconnection(30s)` / `onReconnect`; resend terrain snapshot; turn-timeout auto-forfeits a disconnected active player so matches never stall.
- [ ] **Basic authentication + profile** — sign up / log in / log out, persistent account, display name, win/loss record (and possibly xp). Identity + profile only.
- [ ] **Meta API (REST)** — auth handshake feeding Colyseus `onAuth`, profile read/write, match-results persistence to Postgres.
- [ ] **Deployment** — static client + stateful game server + Meta API + Postgres + Redis deployed to real hosting so playtesters can reach it via a URL (topology decided in research).
- [ ] **Clean-vector tech art** — mechs (body + code-rotated barrel), exploit projectiles + impact FX, datacenter/circuit-board destructible maps, lobby/HUD chrome. Placeholder art acceptable for the slice.

### Out of Scope

<!-- Explicit boundaries with reasoning, so they don't get re-added. -->

- **Gold/cash economy, store, purchases** — content/retention system; adds surface area without answering v0's fun/netcode questions. Data model designed (two-currency, `is_cash_only`) but not wired.
- **Avatar inventory, equipping, stat bonuses, enchanting** — deferred with the economy; the sim's `ProjectileDef`/turn-delay seam exists for server-side stat resolution later.
- **Additional modes (Tag, Score, Jewel, Powerball)** — Solo proves the loop; team/scoring logic is added complexity.
- **Progression / levels / ranking** beyond a basic win/loss record — defer until retention matters.
- **Bots / AI opponents** — not a v0 feature. The sim-search `BotController` reuses `@shared/sim` and is noted as a future dev tool (could slot in early to playtest networked matches solo), but it isn't committed scope.
- **Falling / collapsing terrain + fall damage** — Gunbound-authentic but out of the slice; the bitmask supports it later via flood-fill.
- **Desktop / Steam (Tauri) wrapper** — web-first; server authority matters far more than native hardening.
- **Multi-region / horizontal scaling** — turn-based play is latency-tolerant; a single region carries a long way. Scale vertically first, only go horizontal/Colyseus-Cloud when real traffic forces it.

## Context

- **Genre lineage:** Gunbound/Worms/Scorched-Earth turn-based artillery. The FirewallOps reskin (mechs, exploit projectiles, datacenter/circuit-board maps) is purely cosmetic — mechanics are the proven originals, which lowers design risk.
- **Risk model:** fun risk before tech risk. M1 hotseat is the real go/no-go gate — if the loop isn't fun on the same screen with zero networking, fix the feel before building any multiplayer.
- **Architectural keystone:** `@shared/sim` is one TypeScript package imported by both client and server. Write ballistics + terrain once; the server is the authority and the client sim is a cosmetic preview that snaps to the server's broadcast.
- **Developer background:** coming from web apps; wants to learn the realtime/game-server moving parts (informs the "decide in research" stance on hosting/auth, with a lean toward learning-friendly self-host).
- **Existing design assets in repo:** `TECHNICAL-DESIGN.md` (sim, state machine, terrain, netcode, data model), `MVP-ROADMAP.md` (M0–M4 risk-ordered), `RESEARCH-AUTH-ASSETS-BOTS.md`, `HOSTING-SCALING.md`. They reference a `gunbound-clone-handoff-brief.md` that is not in the repo. Stack/API verified ~Jun 2026.
- **Scope change from original docs:** the docs deferred accounts (guest identities) and treated deploy as post-v0. v0 now includes basic auth/profiles and a real deployment — a bigger but coherent slice, since the seams were already designed.

## Constraints

- **Tech stack (locked):** Phaser 4.1 (TS 5.7 / Vite 6) client + Colyseus 0.17 authoritative server + Postgres + Redis. Colyseus 0.17 API shapes: `defineServer`/`defineRoom`, `messages = {}` handlers, `onDrop`/`onReconnect`, `setMatchmaking`, `validate()` with Zod.
- **Architecture:** monorepo (pnpm/npm workspaces) with `@shared/sim`, `client`, `server`. `@shared/sim` has NO engine or network dependencies so it runs identically in a browser tab and in Node.
- **Server authority (non-negotiable):** client sends intentions, server decides outcomes. Damage/rewards computed only server-side; turn order, active player, wind, and item availability are server-owned; Zod rejects malformed/out-of-range input. The active-player gate is most of the turn-order integrity and anti-cheat.
- **Hosting reality:** the Colyseus game server is stateful (long-lived WebSockets, room state in RAM) and cannot run on serverless/Vercel; the static client can. Deployment must split by statefulness.
- **Determinism:** a non-issue because only the server simulates — no lockstep or fixed-point math needed; the client sim is cosmetic.

## Key Decisions

<!-- Decisions that constrain future work. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tech-themed reskin of Gunbound (aesthetic only) | Reuse a proven-fun loop; theme is paint over locked mechanics | — Pending |
| Full v0 slice (M0–M4) this milestone; M1 = explicit fun gate | Defined v0 is the whole slice incl. lobby; M1 hotseat is the cheapest go/no-go on fun | — Pending |
| Clean-vector art, not pixel | Leans into a sleek tech identity; deliberate break from genre-default pixel; art style is the one painful-to-reverse choice | — Pending |
| Auth/profiles added to v0 — identity + profile only | Account-backed slice wanted now; gold economy/avatars stay deferred | — Pending |
| Real deployment included in v0 | Want a playtest-able deployed slice, not just local | — Pending |
| Items = exploits, maps = datacenters/circuit boards | Theme flavor that gives the reskin identity and items a natural future arsenal | — Pending |
| Auth provider (Clerk vs Better Auth) → decided in research | Reversible/low-stakes; both verify cleanly in `onAuth` | — Pending |
| Hosting topology (Fly.io self-host vs Colyseus Cloud) → decided in research | Managed convenience vs DIY control/cost; let research recommend | — Pending |
| Build `@shared/sim` first, standalone, before any engine/network | Highest-leverage code; everything imports it; isolate to prevent divergence | — Pending |

---
*Last updated: 2026-06-18 after initialization*
