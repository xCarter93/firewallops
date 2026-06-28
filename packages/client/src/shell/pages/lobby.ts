import { mountUserButton } from "../auth.js";
import { convexMatchSession } from "../net/matchSession.js";
import {
  createRoom as convexCreateRoom,
  joinMatch as convexJoinMatch,
  getMyProfile as convexGetMyProfile,
  setMyDisplayName as convexSetMyDisplayName,
} from "../../net/convexClient.js";
import {
  subscribeLobbyConvex,
  type LobbyRoomEntry,
  type LobbySubscription,
} from "../net/lobbyClient.js";
import { FONT, chamfer, angledTab, edgeBar } from "../meshed.js";

/**
 * Lobby / Home Hub page — restyled to the founder's NEW Meshed "Home Hub"
 * command-center (Phase 6, Plan 06-MESHED-B). It consumes the shared Meshed
 * foundation (`shell/meshed.ts` motifs + the shell.css `--*` tokens + the fonts
 * loaded in index.html) — CHAMFER frames, ANGLED-TAB nav/pills, EDGE-BAR rails —
 * exactly as the landing page does. The layout follows MESHED-DESIGN "SCREEN 2 —
 * HOME HUB": a left command sidebar, a center QUICK MATCH hero + mode cards + the
 * live ROOM BROWSER + an INTEL FEED, and a right SQUAD panel.
 *
 * LIVE WIRING — the ROOM-BROWSER list + the create/join cards now run on CONVEX
 * (Phase 9, plan 08). The page visuals/copy are unchanged; only the data wiring
 * moved off Colyseus onto the Convex authority (the Colyseus `subscribeLobby`/
 * `matchSession` halves are deleted at the plan-12 cutover):
 *   - The live room list comes from the REACTIVE `api.lobby.listOpen` Convex query
 *     (`subscribeLobbyConvex`) — NOT a match seat; it re-pushes on any open/full
 *     room change. The ROOM BROWSER region reuses `renderRooms`/`renderRoomRow`/
 *     `renderEmptyState` UNCHANGED (each listOpen row is mapped to LobbyRoomEntry).
 *   - CREATE ROOM / the QUICK MATCH hero DEPLOY CTA + the CUSTOM card route through
 *     `openCreateForm()` → `convexCreateRoom(name, mode)` (mode chosen at create);
 *     a room-row JOIN routes through `convexClient.joinMatch(matchId)`. Both store
 *     the matchId on `convexMatchSession` and navigate to `/room/:matchId`.
 *   - The TRAINING card (plan 07) is UNCHANGED — `convexCreateRoom("TRAINING",
 *     "training")` → straight to `/play/:matchId` (no /room staging).
 *   - The profile block + handle write now run on CONVEX (plan 09-11, review [A1]):
 *     `convexClient.getMyProfile()` / `convexClient.setMyDisplayName()` over the
 *     authed ConvexClient (client.setAuth('convex'), plan 06) — NOT the old REST
 *     Meta-API Bearer surface (which is gone at the plan-12 cutover).
 *   - LOG OUT is the mounted Clerk `UserButton` (AUTH-02).
 *
 * REAL vs ILLUSTRATIVE (founder policy): the seated player's profile DISPLAY NAME
 * + W/L are REAL (from `fetchProfile`, UI-04 partial) and rendered truthfully. The
 * no-backend sections (rank/level/XP, CR/KEYS currency, SQUAD friends, INTEL FEED
 * news/events) have NO data source — they render as clearly-labelled STATIC
 * ILLUSTRATIVE chrome (a `// ILLUSTRATIVE` marker per section + a visible `SYS`
 * tag), consistent with the landing stat-band convention. Numeric fields with no
 * source and no illustrative frame render a muted "—" (never an invented number).
 *
 * Lifecycle: `renderLobby` returns a cleanup fn the router can call on nav-away;
 * it also self-cleans on navigation via the page's own `navigate` wrapper so the
 * lobby subscription never leaks a connection. NO `#game-container` is created
 * here (the canvas-lifecycle smoke invariant).
 */

/** The profile row shape returned by `accounts.getMyProfile` (Convex account row or null). */
interface ProfileRow {
  display_name?: string;
  wins?: number;
  losses?: number;
}

/** The selectable match modes (LOBBY-03) — the only real v0 room knob. */
const MODES = ["1v1", "2v2", "4v4"] as const;
type Mode = (typeof MODES)[number];

/**
 * Inert Convex handlers for the CUSTOM/RANKED create + the JOIN flow (plan 08) AND
 * the TRAINING-card create (plan 07). The lobby only needs
 * the matchId subscribed on convexMatchSession so the next page (room or play) detects
 * the Convex route (currentMatchId === id); the REAL per-doc handlers are supplied
 * by MatchScene.bindConvexMatch when Phaser boots (convexMatchSession.subscribe
 * re-binds, tearing down this inert subscription). No-ops so an early doc patch is harmless.
 */
const inertConvexHandlers = {
  onShotResult: () => {},
  onTerrainSnapshot: () => {},
  onMatchEnded: () => {},
  onStateChange: () => {},
};

/**
 * Read the player's profile (display name + W/L) over the AUTHED ConvexClient
 * (plan 09-11, review [A1]). Returns the row, or `null` if the account has no row /
 * no display name yet (drives the first-login handle prompt). Throws on a network
 * / auth failure so the caller can show a retry affordance. The accountId is
 * derived server-side from the verified subject (D-08) — no Bearer, no REST base.
 */
async function fetchProfile(): Promise<ProfileRow | null> {
  return (await convexGetMyProfile()) as ProfileRow | null;
}

/**
 * Write the chosen handle to `accounts.display_name` via the authed Convex
 * mutation (AUTH-04, plan 09-11). The accountId is derived server-side from the
 * verified subject, never the body (D-08). Throws on a server rejection so the
 * modal can surface the failure.
 */
async function saveHandle(displayName: string): Promise<void> {
  await convexSetMyDisplayName(displayName);
}

/** Render the lobby into `root`. Returns a cleanup fn (tears down the subscription). */
export function renderLobby(
  root: HTMLElement,
  navigate: (path: string) => void,
): () => void {
  root.innerHTML = "";

  let sub: LobbySubscription | null = null;
  let disposed = false;

  /** Tear down the light LobbyRoom subscription (idempotent). */
  const cleanup = (): void => {
    disposed = true;
    sub?.close();
    sub = null;
  };

  /** Navigate away, tearing the subscription down first (no leaked connection). */
  const go = (path: string): void => {
    cleanup();
    navigate(path);
  };

  // ── page shell (Meshed field + faint cyan mesh texture) ───────────────────
  const page = el("div", "fw-lobby");
  Object.assign(page.style, {
    minHeight: "100%",
    height: "100%",
    background: "var(--bg-deep)", // Meshed field #0B1220
    backgroundImage:
      "linear-gradient(rgba(34,211,238,0.03) 1px, transparent 1px), " +
      "linear-gradient(90deg, rgba(34,211,238,0.03) 1px, transparent 1px)",
    backgroundSize: "48px 48px",
    fontFamily: "var(--font-body)",
    color: "var(--text-2)",
    display: "flex",
  } satisfies Partial<CSSStyleDeclaration>);

  // ════════════════════════════════════════════════════════════════════════
  //  LEFT SIDEBAR — brand · profile (REAL name + W/L) · nav · settings/log-out
  // ════════════════════════════════════════════════════════════════════════
  const sidebar = el("aside", "fw-hub-sidebar");
  Object.assign(sidebar.style, {
    width: "252px",
    flex: "none",
    background: "linear-gradient(180deg,#0d1626,#0a1220)",
    borderRight: "1px solid rgba(95,200,245,0.14)",
    display: "flex",
    flexDirection: "column",
    padding: "22px 0",
  } satisfies Partial<CSSStyleDeclaration>);

  // Brand row — hex sigil + wordmark (static chrome).
  const brandRow = el("div", "fw-hub-brand");
  Object.assign(brandRow.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "0 22px 22px",
    borderBottom: "1px solid rgba(95,200,245,0.1)",
  } satisfies Partial<CSSStyleDeclaration>);
  brandRow.innerHTML =
    `<span style="width:26px;height:26px;clip-path:polygon(25% 0,75% 0,100% 50%,` +
    `75% 100%,25% 100%,0 50%);background:linear-gradient(135deg,var(--glow),` +
    `#0891b2)"></span>` +
    `<span style="font-family:${FONT.display};font-weight:800;font-size:15px;` +
    `letter-spacing:0.06em;color:var(--text)">FIREWALL` +
    `<span style="color:var(--accent)">OPS</span></span>`;

  // ── PROFILE CLUSTER (chamfered, bracket-hex avatar) ───────────────────────
  // REAL: callsign + W/L from fetchProfile. ILLUSTRATIVE: rank tier + XP bar.
  const profileCard = el("div", "fw-hub-profile");
  Object.assign(profileCard.style, {
    position: "relative",
    margin: "18px 14px",
    padding: "16px 16px 18px",
    background: "linear-gradient(180deg,rgba(18,29,49,0.6),rgba(11,18,32,0.5))",
    border: "1px solid rgba(95,200,245,0.16)",
    clipPath: chamfer(12),
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  } satisfies Partial<CSSStyleDeclaration>);
  // Left edge-bar (parent is position:relative).
  profileCard.insertAdjacentHTML("afterbegin", edgeBar(3, 10));

  const profileTop = el("div", "fw-hub-profile-top");
  Object.assign(profileTop.style, {
    display: "flex",
    gap: "14px",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);

  // Bracket-hex avatar (violet hex frame + corner bracket) — static chrome.
  const avatar = document.createElement("div");
  Object.assign(avatar.style, {
    position: "relative",
    width: "52px",
    height: "52px",
    flex: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  avatar.innerHTML =
    `<div style="width:100%;height:100%;clip-path:polygon(25% 0,75% 0,100% 50%,` +
    `75% 100%,25% 100%,0 50%);background:linear-gradient(135deg,var(--violet),` +
    `#6d28d9)"></div>` +
    `<div style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;` +
    `border-top:2px solid var(--glow);border-right:2px solid var(--glow)"></div>`;

  const profileText = el("div", "fw-hub-profile-text");
  Object.assign(profileText.style, {
    minWidth: "0",
    flex: "1",
  } satisfies Partial<CSSStyleDeclaration>);

  // REAL display name (UI-04 partial). textContent only — never innerHTML.
  const handleEl = el("div", "fw-profile-handle");
  Object.assign(handleEl.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "15px",
    letterSpacing: "0.04em",
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies Partial<CSSStyleDeclaration>);
  handleEl.textContent = "—";
  // Click the handle to change it later — the prompt copy promises this (AUTH-04).
  // Opens the same prompt prefilled, in cancelable "change" mode (vs the blocking
  // first-login gate). Skips the placeholder/error sentinels when seeding.
  handleEl.style.cursor = "pointer";
  handleEl.title = "Click to change your handle";
  handleEl.addEventListener("click", () => {
    const current = handleEl.textContent ?? "";
    const seed = current === "—" || current === "AGENT" ? "" : current;
    openHandlePrompt({ change: true, current: seed });
  });

  // ILLUSTRATIVE: rank tier (no backend) — labelled SYS chrome.
  const rankEl = el("div", "fw-hub-rank");
  Object.assign(rankEl.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "4px",
    fontSize: "10px",
    letterSpacing: "0.08em",
    color: "var(--violet-2)",
  } satisfies Partial<CSSStyleDeclaration>);
  rankEl.textContent = "◆ DIAMOND III"; // ILLUSTRATIVE rank tier (no backend)
  rankEl.title = "Illustrative — rank tiers are not yet wired to a backend.";

  // REAL W/L line (UI-04 partial). textContent only.
  const wlEl = el("div", "fw-profile-wl");
  Object.assign(wlEl.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--muted)",
    marginTop: "5px",
  } satisfies Partial<CSSStyleDeclaration>);
  wlEl.textContent = "W 0 · L 0";

  profileText.append(handleEl, rankEl, wlEl);
  profileTop.append(avatar, profileText);

  // ILLUSTRATIVE XP / level band — sourceless numerics behind a SYS frame.
  const xpBand = el("div", "fw-hub-xp");
  xpBand.innerHTML =
    `<div style="display:flex;justify-content:space-between;font-size:10px;` +
    `color:var(--faint);margin-bottom:5px"><span>SYS · LVL —</span>` +
    `<span style="font-family:${FONT.mono};color:var(--text-2)">— / — XP</span></div>` +
    `<div style="height:5px;background:#16233c;overflow:hidden;clip-path:` +
    `polygon(2px 0,100% 0,calc(100% - 2px) 100%,0 100%)"><div style="width:68%;` +
    `height:100%;background:linear-gradient(90deg,var(--accent),var(--violet));` +
    `opacity:0.55"></div></div>` +
    `<div style="font-family:${FONT.mono};font-size:8px;letter-spacing:0.16em;` +
    `color:var(--faint);margin-top:5px">// ILLUSTRATIVE — NO XP BACKEND</div>`;

  profileCard.append(profileTop, xpBand);

  // ── NAV (active = angled edge-bar; PLAY active) ───────────────────────────
  // The ROOM BROWSER nav item scrolls the live room list into view; the rest are
  // display-only scaffolding for the not-yet-built surfaces.
  const nav = el("nav", "fw-hub-nav");
  Object.assign(nav.style, {
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    flex: "1",
  } satisfies Partial<CSSStyleDeclaration>);

  // Active PLAY item (angled edge-bar) — focuses the QUICK MATCH hero.
  const playNav = el("button", "fw-hub-nav-item");
  playNav.type = "button";
  Object.assign(playNav.style, {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "11px 14px",
    background: "rgba(34,211,238,0.12)",
    clipPath: "polygon(0 0,100% 0,100% 100%,8px 100%,0 calc(100% - 8px))",
    color: "var(--glow)",
    fontFamily: "var(--font-display)",
    fontWeight: "600",
    fontSize: "12px",
    letterSpacing: "0.06em",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  playNav.innerHTML =
    `<span style="position:absolute;left:0;top:4px;bottom:4px;width:3px;` +
    `background:linear-gradient(180deg,var(--glow),var(--edge));box-shadow:` +
    `0 0 10px var(--edge)"></span><span style="font-size:14px">◈</span> PLAY`;
  nav.appendChild(playNav);

  // Display-only nav scaffolding (ROOM BROWSER scrolls to the live list).
  for (const item of [
    { glyph: "◇", label: "ROSTER / GARAGE", id: "" },
    { glyph: "▤", label: "ROOM BROWSER", id: "browser" },
    { glyph: "◭", label: "STORE", id: "" },
    { glyph: "⊡", label: "CAREER", id: "" },
  ]) {
    const n = el("button", "fw-hub-nav-item");
    n.type = "button";
    Object.assign(n.style, {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "11px 14px",
      background: "transparent",
      color: "var(--text-2)",
      fontFamily: "var(--font-display)",
      fontWeight: "500",
      fontSize: "12px",
      letterSpacing: "0.06em",
      border: "none",
      textAlign: "left",
      cursor: item.id === "browser" ? "pointer" : "default",
    } satisfies Partial<CSSStyleDeclaration>);
    // glyph + label via textContent-safe nodes (static literals, but kept tidy).
    const g = document.createElement("span");
    g.style.fontSize = "14px";
    g.textContent = item.glyph;
    n.append(g, document.createTextNode(" " + item.label));
    if (item.id === "browser") {
      n.addEventListener("click", () =>
        listSection.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
    nav.appendChild(n);
  }

  // ── settings / log-out footer (Clerk UserButton lives here) ───────────────
  const sidebarFoot = el("div", "fw-hub-foot");
  Object.assign(sidebarFoot.style, {
    padding: "14px 18px",
    borderTop: "1px solid rgba(95,200,245,0.1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontFamily: "var(--font-display)",
    fontSize: "11px",
    letterSpacing: "0.06em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const settingsLbl = document.createElement("span");
  settingsLbl.textContent = "SETTINGS";
  // Clerk UserButton mount target — provides LOG OUT (AUTH-02).
  const userButtonMount = document.createElement("div");
  userButtonMount.className = "fw-userbutton";
  sidebarFoot.append(settingsLbl, userButtonMount);

  sidebar.append(brandRow, profileCard, nav, sidebarFoot);

  // ════════════════════════════════════════════════════════════════════════
  //  CENTER — top bar · QUICK MATCH hero + mode cards · ROOM BROWSER · INTEL
  // ════════════════════════════════════════════════════════════════════════
  const center = el("main", "fw-hub-center");
  Object.assign(center.style, {
    flex: "1",
    minWidth: "0",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  } satisfies Partial<CSSStyleDeclaration>);

  // ── top bar: COMMAND CENTER label · CR/KEYS (illustrative "—") · gear ──────
  const topbar = el("header", "fw-hub-topbar");
  Object.assign(topbar.style, {
    height: "60px",
    flex: "none",
    borderBottom: "1px solid rgba(95,200,245,0.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 28px",
    background: "var(--bg-deep)",
  } satisfies Partial<CSSStyleDeclaration>);
  topbar.innerHTML =
    `<div style="display:flex;align-items:center;gap:12px">` +
    `<span style="font-family:${FONT.display};font-size:12px;letter-spacing:0.12em;` +
    `color:var(--text-2)">COMMAND CENTER</span>` +
    `<span style="font-family:${FONT.display};color:var(--glow);font-size:11px">//</span></div>` +
    // CR / KEYS currency — NO backend → muted "—" (never an invented number).
    `<div style="display:flex;align-items:center;gap:20px">` +
    `<div style="display:flex;align-items:center;gap:8px" title="Illustrative — currency is not yet wired to a backend.">` +
    `<span style="color:var(--accent);font-size:13px">◈</span>` +
    `<span style="font-family:${FONT.mono};color:var(--text);font-size:14px">—</span>` +
    `<span style="font-size:10px;color:var(--faint)">CR</span></div>` +
    `<div style="display:flex;align-items:center;gap:8px" title="Illustrative — currency is not yet wired to a backend.">` +
    `<span style="color:var(--violet-2);font-size:13px">◆</span>` +
    `<span style="font-family:${FONT.mono};color:var(--text);font-size:14px">—</span>` +
    `<span style="font-size:10px;color:var(--faint)">KEYS</span></div>` +
    `<div style="width:1px;height:22px;background:rgba(95,200,245,0.15)"></div>` +
    `<div style="width:32px;height:32px;border:1px solid rgba(95,200,245,0.2);` +
    `clip-path:polygon(0 7px,7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%);` +
    `display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:14px">⚙</div></div>`;

  // ── center scroll body ────────────────────────────────────────────────────
  const centerBody = el("div", "fw-hub-body");
  Object.assign(centerBody.style, {
    flex: "1",
    padding: "24px 28px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  } satisfies Partial<CSSStyleDeclaration>);

  // ── QUICK MATCH hero (chamfered + edge-bar + mesh grid + glow) ─────────────
  // The DEPLOY ▸ CTA routes through the EXISTING create flow (openCreateForm).
  const hero = el("section", "fw-hub-hero");
  Object.assign(hero.style, {
    position: "relative",
    overflow: "hidden",
    border: "1px solid rgba(95,200,245,0.28)",
    clipPath: chamfer(16),
    background: "linear-gradient(120deg,#16233c 0%,#0d1830 60%,#1a1430 100%)",
    display: "flex",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);
  // Decorative mesh grid + glow + hero edge-bar (static chrome).
  hero.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:absolute;inset:0;background-image:` +
      `linear-gradient(rgba(34,211,238,0.05) 1px,transparent 1px),` +
      `linear-gradient(90deg,rgba(34,211,238,0.05) 1px,transparent 1px);` +
      `background-size:36px 36px;pointer-events:none"></div>` +
      `<div style="position:absolute;top:-120px;right:80px;width:420px;height:420px;` +
      `background:radial-gradient(circle,rgba(34,211,238,0.18),transparent 60%);` +
      `pointer-events:none"></div>` +
      `<div style="position:absolute;left:0;top:14px;bottom:14px;width:4px;` +
      `background:linear-gradient(180deg,var(--glow),var(--edge));` +
      `box-shadow:0 0 14px var(--edge);pointer-events:none"></div>`,
  );

  // Hero copy column.
  const heroCopy = el("div", "fw-hub-hero-copy");
  Object.assign(heroCopy.style, {
    position: "relative",
    padding: "32px 34px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: "20px",
    flex: "1 1 360px",
    minWidth: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  heroCopy.innerHTML =
    `<div><div style="font-family:${FONT.mono};font-size:11px;letter-spacing:0.16em;` +
    `color:var(--glow);margin-bottom:12px">▸ READY TO DEPLOY</div>` +
    `<div style="font-family:${FONT.display};font-weight:900;font-size:clamp(30px,4vw,40px);` +
    `line-height:1;color:var(--text)">QUICK<br>MATCH</div>` +
    `<div style="font-size:13px;color:var(--text-2);margin-top:14px;line-height:1.6">` +
    `Spin up a room and breach. Modes 1v1 to 4v4.</div></div>`;

  // Hero CTA row — DEPLOY ▸ (live: openCreateForm) + RANKED (illustrative).
  const heroCtas = el("div", "fw-hub-hero-ctas");
  Object.assign(heroCtas.style, {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const deployBtn = el("button", "fw-btn-primary");
  deployBtn.type = "button";
  deployBtn.textContent = "DEPLOY ▸";
  Object.assign(deployBtn.style, {
    padding: "14px 38px",
    background: "linear-gradient(180deg,var(--glow),var(--accent))",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "15px",
    letterSpacing: "0.08em",
    border: "none",
    borderRadius: "0",
    clipPath: chamfer(10),
    boxShadow: "0 0 30px -6px rgba(34,211,238,0.6)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  // LIVE: routes through the existing create flow (no new join path invented).
  deployBtn.addEventListener("click", () => openCreateForm());

  const rankedBtn = el("button", "fw-hub-ranked");
  rankedBtn.type = "button";
  rankedBtn.textContent = "RANKED";
  rankedBtn.title = "Illustrative — ranked queue is not yet wired.";
  Object.assign(rankedBtn.style, {
    padding: "14px 22px",
    background: "transparent",
    border: "1px solid rgba(95,200,245,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-display)",
    fontWeight: "600",
    fontSize: "12px",
    letterSpacing: "0.06em",
    clipPath: chamfer(9),
    cursor: "default",
  } satisfies Partial<CSSStyleDeclaration>);

  heroCtas.append(deployBtn, rankedBtn);
  heroCopy.appendChild(heroCtas);

  // Mode cards — RANKED / CUSTOM / TRAINING. CUSTOM is LIVE (openCreateForm);
  // the other two are illustrative scaffolding.
  const modeCards = el("div", "fw-hub-modecards");
  Object.assign(modeCards.style, {
    position: "relative",
    flex: "1 1 320px",
    display: "flex",
    gap: "12px",
    alignItems: "center",
    padding: "24px 28px 24px 0",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);
  modeCards.appendChild(
    modeCard("⚔", "var(--accent)", "RANKED", "Climb the ladder", "Illustrative — ranked is not yet wired.", null),
  );
  modeCards.appendChild(
    // CUSTOM is the LIVE create-a-room path.
    modeCard("⬢", "var(--violet-2)", "CUSTOM", "Build a room", null, () => openCreateForm()),
  );
  // Guard against a double-click on TRAINING creating two rooms (the create is
  // async; a second click before it resolves would fire a second createRoom).
  let trainingCreatePending = false;
  modeCards.appendChild(
    // TRAINING is the LIVE solo-range path — now on CONVEX (plan 07). It calls the
    // Convex `createRoom({mode:'training'})` mutation, which seats the caller, spawns
    // the passive dummy, and starts the turn server-side (status: "active", so the
    // training room is inherently UNLISTED — lobby.listOpen never returns it). Training
    // starts immediately, so it forwards straight to /play/:matchId (no /room staging).
    // The matchId is stored in convexMatchSession so the play page drives the Convex
    // training path. Auth-gate preserved (D-10 — card only available signed-in); the
    // manual getToken() pass is DROPPED (the Convex path authenticates via
    // client.setAuth('convex'), wired in shell/auth.ts plan 06).
    modeCard("◎", "var(--warn)", "TRAINING", "Solo range", null, () => {
      if (trainingCreatePending) return; // double-click → no duplicate rooms.
      trainingCreatePending = true;
      void (async () => {
        try {
          const matchId = await convexCreateRoom("TRAINING", "training");
          convexMatchSession.subscribe(matchId, inertConvexHandlers);
          go(`/play/${encodeURIComponent(matchId)}`);
        } catch (e) {
          trainingCreatePending = false; // allow a retry after a failed create.
          console.error("[lobby] training create failed", e);
        }
      })();
    }),
  );

  hero.append(heroCopy, modeCards);

  // ── ROOM BROWSER (LIVE — reuses renderRooms/renderRoomRow/renderEmptyState) ─
  const listSection = el("section", "fw-hub-browser");
  Object.assign(listSection.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } satisfies Partial<CSSStyleDeclaration>);

  const listHeader = el("div", "fw-list-header");
  Object.assign(listHeader.style, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  } satisfies Partial<CSSStyleDeclaration>);
  const listTitle = el("h2", "fw-list-title");
  Object.assign(listTitle.style, {
    fontFamily: "var(--font-display)",
    fontSize: "11px",
    letterSpacing: "0.14em",
    color: "var(--text-2)",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  listTitle.textContent = "ROOM BROWSER — OPEN ROOMS";
  // Dashed rail divider (static chrome).
  const railSpacer = document.createElement("div");
  Object.assign(railSpacer.style, {
    flex: "1",
    height: "1px",
    background:
      "repeating-linear-gradient(90deg, rgba(95,200,245,0.4) 0 6px, transparent 6px 12px)",
  } satisfies Partial<CSSStyleDeclaration>);
  const createBtn = el("button", "fw-hub-create");
  createBtn.type = "button";
  createBtn.textContent = "CREATE ROOM"; // exact copy.
  Object.assign(createBtn.style, {
    padding: "9px 18px",
    background: "transparent",
    color: "var(--accent)",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "11px",
    letterSpacing: "0.08em",
    border: "1px solid var(--accent)",
    clipPath: angledTab(9),
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  createBtn.addEventListener("click", () => openCreateForm());
  listHeader.append(listTitle, railSpacer, createBtn);

  const listEl = el("div", "fw-room-list");
  Object.assign(listEl.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
  listSection.append(listHeader, listEl);

  // ── INTEL FEED (illustrative news + events — labelled SYS chrome) ──────────
  const intel = renderIntelFeed();

  centerBody.append(hero, listSection, intel);
  center.append(topbar, centerBody);

  // ════════════════════════════════════════════════════════════════════════
  //  RIGHT — SQUAD panel (illustrative friends list — labelled SYS chrome)
  // ════════════════════════════════════════════════════════════════════════
  const squad = renderSquadPanel();

  page.append(sidebar, center, squad);
  root.appendChild(page);

  // Mount the Clerk user button (LOG OUT).
  mountUserButton(userButtonMount);

  // ── room-list rendering (LIVE — unchanged behavior) ───────────────────────
  function renderRooms(rooms: LobbyRoomEntry[]): void {
    listEl.innerHTML = "";

    // C2: only list JOINABLE rooms — drop locked/in-progress rooms (their disabled
    // "LOCKED" rows were noise; a room mid-match isn't actionable). Training rooms
    // are already unlisted server-side, so this only hides real in-progress matches.
    const joinable = rooms.filter((room) => !(room.metadata?.locked ?? false));

    if (joinable.length === 0) {
      listEl.appendChild(renderEmptyState(() => openCreateForm()));
      return;
    }

    for (const room of joinable) {
      listEl.appendChild(renderRoomRow(room));
    }
  }

  /** A single room row: name · mode · N/M · open/locked · join affordance. */
  function renderRoomRow(room: LobbyRoomEntry): HTMLElement {
    const meta = room.metadata;
    const name = meta?.name ?? "ROOM";
    const mode = meta?.mode ?? "1v1";
    const players = meta?.players ?? room.clients;
    const maxPlayers = meta?.maxPlayers ?? room.maxClients;
    const locked = meta?.locked ?? false;

    const row = el("div", "fw-room-row");
    Object.assign(row.style, {
      position: "relative",
      display: "flex",
      alignItems: "center",
      gap: "var(--space-md)",
      padding: "13px 16px",
      background: "var(--surface)",
      border: "1px solid rgba(95,200,245,0.14)",
      clipPath: chamfer(10),
    } satisfies Partial<CSSStyleDeclaration>);

    const nameEl = el("div", "fw-room-name");
    Object.assign(nameEl.style, {
      flex: "1",
      minWidth: "0",
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "13px",
      letterSpacing: "0.04em",
      color: "var(--text)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    // textContent — never innerHTML with room data (XSS guard).
    nameEl.textContent = name;

    const modeEl = el("div", "fw-room-mode fw-label");
    modeEl.textContent = mode;

    const countEl = el("div", "fw-room-count");
    Object.assign(countEl.style, {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      color: "var(--text-2)",
      minWidth: "44px",
      textAlign: "center",
    } satisfies Partial<CSSStyleDeclaration>);
    countEl.textContent = `${players}/${maxPlayers}`;

    const stateEl = el("div", "fw-room-state fw-label");
    stateEl.textContent = locked ? "LOCKED" : "OPEN";
    stateEl.style.color = locked ? "var(--faint)" : "var(--ready)";

    const joinBtn = el("button", "fw-room-join");
    joinBtn.type = "button";
    joinBtn.textContent = locked ? "LOCKED" : "JOIN ▸";
    Object.assign(joinBtn.style, {
      padding: "8px 18px",
      background: "transparent",
      color: locked ? "var(--faint)" : "var(--accent)",
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "12px",
      letterSpacing: "0.08em",
      border: `1px solid ${locked ? "var(--line)" : "var(--accent)"}`,
      clipPath: angledTab(9),
      cursor: locked ? "not-allowed" : "pointer",
    } satisfies Partial<CSSStyleDeclaration>);
    joinBtn.disabled = locked;
    if (!locked) {
      // Join (plan 08) — Convex: seat the caller via the `joinMatch` mutation
      // (server derives identity from the verified subject + enforces capacity),
      // store the matchId on convexMatchSession (so the room/play pages drive the
      // Convex route), then navigate to the staging room. The roomId IS the Convex
      // matchId (rowToEntry maps matchId → roomId in lobbyClient).
      joinBtn.addEventListener("click", () => {
        void (async () => {
          joinBtn.disabled = true;
          try {
            const matchId = room.roomId;
            await convexJoinMatch(matchId);
            convexMatchSession.subscribe(matchId, inertConvexHandlers);
            go(`/room/${encodeURIComponent(matchId)}`);
          } catch (e) {
            joinBtn.disabled = false;
            console.error("[lobby] join failed", e);
          }
        })();
      });
    }

    row.append(nameEl, modeEl, countEl, stateEl, joinBtn);
    return row;
  }

  // ── CREATE ROOM form (mode select + name; map = single-option stub) ────────
  function openCreateForm(): void {
    const overlay = modalOverlay();
    const card = modalCard();

    const title = el("h3", "fw-modal-title");
    Object.assign(title.style, {
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "18px",
      letterSpacing: "0.06em",
      color: "var(--text)",
      marginBottom: "var(--space-md)",
    } satisfies Partial<CSSStyleDeclaration>);
    title.textContent = "CREATE ROOM"; // exact copy.

    const nameInput = textInput("ROOM NAME");
    nameInput.value = "NEW BREACH";

    const modeRow = el("div", "fw-mode-row");
    Object.assign(modeRow.style, {
      display: "flex",
      gap: "var(--space-sm)",
      margin: "var(--space-md) 0",
    } satisfies Partial<CSSStyleDeclaration>);
    let selectedMode: Mode = "1v1";
    const modeButtons: HTMLButtonElement[] = [];
    for (const m of MODES) {
      const b = el("button", "fw-mode-opt");
      b.type = "button";
      b.textContent = m;
      Object.assign(b.style, {
        flex: "1",
        padding: "10px",
        background: m === selectedMode ? "var(--surface-2)" : "transparent",
        color: m === selectedMode ? "var(--accent)" : "var(--muted)",
        fontFamily: "var(--font-display)",
        fontWeight: "700",
        fontSize: "12px",
        letterSpacing: "0.06em",
        border: `1px solid ${m === selectedMode ? "var(--accent)" : "var(--line)"}`,
        borderRadius: "var(--radius-3)",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      b.addEventListener("click", () => {
        selectedMode = m;
        for (const btn of modeButtons) {
          const on = btn.textContent === selectedMode;
          btn.style.background = on ? "var(--surface-2)" : "transparent";
          btn.style.color = on ? "var(--accent)" : "var(--muted)";
          btn.style.border = `1px solid ${on ? "var(--accent)" : "var(--line)"}`;
        }
      });
      modeButtons.push(b);
      modeRow.appendChild(b);
    }

    // Map = single-option stub (display-only; UI-SPEC scope-trim).
    const mapRow = el("div", "fw-map-row");
    Object.assign(mapRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px var(--space-md)",
      background: "var(--bg-deep)",
      border: "1px solid var(--line-faint)",
      borderRadius: "var(--radius-3)",
      marginBottom: "var(--space-md)",
    } satisfies Partial<CSSStyleDeclaration>);
    const mapLabel = el("span", "fw-label");
    mapLabel.textContent = "MAP";
    const mapVal = el("span", "fw-map-val");
    Object.assign(mapVal.style, {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      color: "var(--text-2)",
    } satisfies Partial<CSSStyleDeclaration>);
    mapVal.textContent = "DEFAULT";
    mapRow.append(mapLabel, mapVal);

    const err = el("div", "fw-modal-err");
    Object.assign(err.style, {
      color: "var(--danger)",
      fontSize: "11px",
      minHeight: "16px",
      marginBottom: "var(--space-sm)",
    } satisfies Partial<CSSStyleDeclaration>);

    const actions = el("div", "fw-modal-actions");
    Object.assign(actions.style, {
      display: "flex",
      gap: "var(--space-sm)",
      justifyContent: "flex-end",
    } satisfies Partial<CSSStyleDeclaration>);

    const cancel = ghostButton("CANCEL");
    cancel.addEventListener("click", () => overlay.remove());

    const confirm = el("button", "fw-btn-primary");
    confirm.type = "button";
    confirm.textContent = "DEPLOY ROOM";
    confirm.addEventListener("click", () => {
      void (async () => {
        confirm.disabled = true;
        err.textContent = "";
        try {
          // CREATE ROOM (plan 08) — Convex: the `createRoom(name, mode)` mutation
          // creates the WAITING match, seats the caller (room master), and sets the
          // per-mode capacity (teamSizeForMode) server-side. It returns the new
          // matchId. Mode (1v1/2v2/4v4) is chosen here at create time. Store the
          // matchId on convexMatchSession so the room/play pages drive the Convex
          // route, then navigate to the staging room. Auth is client.setAuth('convex')
          // (plan 06) — no manual getToken() pass needed.
          const matchId = await convexCreateRoom(
            nameInput.value.trim() || "NEW BREACH",
            selectedMode,
          );
          convexMatchSession.subscribe(matchId, inertConvexHandlers);
          overlay.remove();
          go(`/room/${encodeURIComponent(matchId)}`);
        } catch (e) {
          confirm.disabled = false;
          err.textContent =
            "COULD NOT CREATE — the server rejected the room. Try again.";
          console.error("[lobby] create room failed", e);
        }
      })();
    });

    actions.append(cancel, confirm);
    card.append(title, nameInput, modeRow, mapRow, err, actions);
    overlay.appendChild(card);
    root.appendChild(overlay);
    nameInput.focus();
  }

  // ── first-login handle prompt (AUTH-04) ───────────────────────────────────
  function openHandlePrompt(
    opts: { change?: boolean; current?: string } = {},
  ): void {
    const isChange = opts.change === true;
    const overlay = modalOverlay();
    // First-login BLOCKS lobby use until a handle is set (no cancel); a later
    // "change" from the sidebar is cancelable, so only gate the first-login path.
    if (!isChange) overlay.dataset.blocking = "true";
    const card = modalCard();

    const title = el("h3", "fw-modal-title");
    Object.assign(title.style, {
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "18px",
      letterSpacing: "0.06em",
      color: "var(--text)",
      marginBottom: "var(--space-sm)",
    } satisfies Partial<CSSStyleDeclaration>);
    title.textContent = "CHOOSE YOUR HANDLE"; // exact copy.

    const bodyText = el("p", "fw-modal-body");
    Object.assign(bodyText.style, {
      fontSize: "12px",
      lineHeight: "1.6",
      color: "var(--muted)",
      margin: "0 0 var(--space-md)",
    } satisfies Partial<CSSStyleDeclaration>);
    // exact copy (UI-SPEC Copywriting Contract).
    bodyText.textContent =
      "This is the call-sign other agents see. You can change it later.";

    const input = textInput("HANDLE");
    // Change mode prefills the current handle so it can be edited in place.
    if (isChange && opts.current) input.value = opts.current;

    const err = el("div", "fw-modal-err");
    Object.assign(err.style, {
      color: "var(--danger)",
      fontSize: "11px",
      minHeight: "16px",
      margin: "var(--space-sm) 0",
    } satisfies Partial<CSSStyleDeclaration>);

    const confirm = el("button", "fw-btn-primary");
    confirm.type = "button";
    confirm.textContent = "CONFIRM HANDLE"; // exact copy.
    Object.assign(confirm.style, {
      width: isChange ? "auto" : "100%",
      justifyContent: "center",
    });
    confirm.addEventListener("click", () => {
      void (async () => {
        const handle = input.value.trim();
        if (handle.length === 0) {
          err.textContent = "Enter a handle to continue.";
          return;
        }
        confirm.disabled = true;
        err.textContent = "";
        try {
          await saveHandle(handle);
          overlay.remove();
          // Re-read the profile so the top bar reflects the new handle.
          await loadProfile();
        } catch (e) {
          confirm.disabled = false;
          err.textContent = "COULD NOT SAVE — try a different handle.";
          console.error("[lobby] handle write failed", e);
        }
      })();
    });

    if (isChange) {
      // Cancelable layout: CANCEL backs out without changing the handle.
      const actions = el("div", "fw-modal-actions");
      Object.assign(actions.style, {
        display: "flex",
        gap: "var(--space-sm)",
        justifyContent: "flex-end",
        marginTop: "var(--space-sm)",
      } satisfies Partial<CSSStyleDeclaration>);
      const cancel = ghostButton("CANCEL");
      cancel.addEventListener("click", () => overlay.remove());
      actions.append(cancel, confirm);
      card.append(title, bodyText, input, err, actions);
    } else {
      card.append(title, bodyText, input, err, confirm);
    }
    overlay.appendChild(card);
    root.appendChild(overlay);
    input.focus();
  }

  // ── profile read + handle gate (LIVE — unchanged data path) ────────────────
  async function loadProfile(): Promise<void> {
    try {
      const profile = await fetchProfile();
      const handle = profile?.display_name;
      if (!handle || handle.length === 0) {
        // First login (no display name) → block lobby use until a handle is set.
        openHandlePrompt();
        return;
      }
      handleEl.textContent = handle;
      wlEl.textContent = `W ${profile.wins ?? 0} · L ${profile.losses ?? 0}`;
    } catch (e) {
      handleEl.textContent = "AGENT";
      wlEl.textContent = "W — · L —";
      console.error("[lobby] profile read failed", e);
    }
  }

  // ── boot the page: subscribe to the live list + read the profile ───────────
  // Plan 08: the room list is now the REACTIVE `api.lobby.listOpen` Convex query
  // (subscribeLobbyConvex) — it re-pushes whenever any open/full room's
  // status/roster/phase changes (no manual "+"/"-" folding). Unlike the Colyseus
  // subscribeLobby this is SYNCHRONOUS (no join await); it returns the LobbySubscription
  // handle directly, whose close() unsubscribes the query (no lobby seat to leave).
  try {
    const subscription = subscribeLobbyConvex((rooms) => {
      // If the page was torn down (nav-away), unsubscribe and skip the render.
      if (disposed) {
        subscription.close();
        return;
      }
      renderRooms(rooms);
    });
    if (disposed) {
      subscription.close();
    } else {
      sub = subscription;
    }
  } catch (e) {
    renderRooms([]);
    console.error("[lobby] room-list subscription failed", e);
  }
  // Render the empty state immediately (replaced when the first push arrives).
  renderRooms([]);
  void loadProfile();

  return cleanup;
}

// ── shared primitives ────────────────────────────────────────────────────────

/**
 * A center mode card (chamfered tile). When `onClick` is supplied the card is a
 * LIVE action (e.g. CUSTOM → create a room); when `illTitle` is supplied instead
 * the card is STATIC ILLUSTRATIVE scaffolding (hover title explains).
 */
function modeCard(
  glyph: string,
  glyphColor: string,
  title: string,
  blurb: string,
  illTitle: string | null,
  onClick: (() => void) | null,
): HTMLElement {
  const card = document.createElement(onClick ? "button" : "div");
  Object.assign(card.style, {
    flex: "1 1 120px",
    minWidth: "120px",
    height: "180px",
    background: "rgba(11,18,32,0.7)",
    border: "1px solid rgba(95,200,245,0.14)",
    clipPath: chamfer(10),
    padding: "18px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    textAlign: "left",
    cursor: onClick ? "pointer" : "default",
  } satisfies Partial<CSSStyleDeclaration>);
  if (onClick) {
    (card as HTMLButtonElement).type = "button";
    card.addEventListener("click", onClick);
  } else if (illTitle) {
    card.title = illTitle;
  }

  const g = document.createElement("span");
  Object.assign(g.style, { fontSize: "22px", color: glyphColor } satisfies Partial<CSSStyleDeclaration>);
  g.textContent = glyph;

  const meta = document.createElement("div");
  const t = document.createElement("div");
  Object.assign(t.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "13px",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  t.textContent = title;
  const b = document.createElement("div");
  Object.assign(b.style, {
    fontSize: "10px",
    color: "var(--faint)",
    marginTop: "4px",
  } satisfies Partial<CSSStyleDeclaration>);
  b.textContent = onClick ? blurb : `${blurb} · SYS`;
  meta.append(t, b);

  card.append(g, meta);
  return card;
}

/**
 * The INTEL FEED region — STATIC ILLUSTRATIVE news + events (no backend). The
 * sample content mirrors the Meshed mockup but is explicitly marked illustrative
 * (a SYS lead-in + a `// ILLUSTRATIVE` note), and surfaces the locked empty-state
 * copy so a future data wire-up has a home. Static markup only (no caller input).
 */
function renderIntelFeed(): HTMLElement {
  const wrap = el("section", "fw-hub-intel");
  Object.assign(wrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } satisfies Partial<CSSStyleDeclaration>);

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  } satisfies Partial<CSSStyleDeclaration>);
  header.innerHTML =
    `<span style="font-family:${FONT.display};font-size:11px;letter-spacing:0.14em;` +
    `color:var(--text-2)">INTEL FEED — NEWS &amp; EVENTS</span>` +
    `<div style="flex:1;height:1px;background:repeating-linear-gradient(90deg,` +
    `rgba(95,200,245,0.4) 0 6px,transparent 6px 12px)"></div>` +
    `<span style="font-family:${FONT.mono};font-size:8px;letter-spacing:0.16em;` +
    `color:var(--faint)">// ILLUSTRATIVE · NO INTEL YET</span>`;

  const grid = document.createElement("div");
  Object.assign(grid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
    gap: "14px",
  } satisfies Partial<CSSStyleDeclaration>);

  // Featured (violet) — SYS season card.
  const featured = document.createElement("div");
  Object.assign(featured.style, {
    position: "relative",
    overflow: "hidden",
    minHeight: "150px",
    gridColumn: "span 1",
    border: "1px solid rgba(168,85,247,0.32)",
    clipPath: chamfer(12),
    background: "linear-gradient(135deg,#1a1438,#0d1326)",
  } satisfies Partial<CSSStyleDeclaration>);
  featured.title = "Illustrative — the intel feed is not yet wired to a backend.";
  featured.innerHTML =
    `<div style="position:absolute;inset:0;background-image:linear-gradient(` +
    `rgba(168,85,247,0.06) 1px,transparent 1px);background-size:30px 30px"></div>` +
    `<div style="position:absolute;left:0;top:12px;bottom:12px;width:3px;` +
    `background:linear-gradient(180deg,var(--violet-2),#7c3aed);box-shadow:0 0 12px #7c3aed"></div>` +
    `<div style="position:relative;padding:22px 24px;height:100%;display:flex;` +
    `flex-direction:column;justify-content:flex-end">` +
    `<span style="align-self:flex-start;font-family:${FONT.mono};font-size:9px;` +
    `letter-spacing:0.14em;color:var(--violet-2);border:1px solid rgba(168,85,247,0.4);` +
    `padding:3px 8px;margin-bottom:10px">SYS · SAMPLE</span>` +
    `<div style="font-family:${FONT.display};font-weight:800;font-size:18px;` +
    `color:var(--text)">ZERO-DAY PROTOCOL</div>` +
    `<div style="font-size:12px;color:#cfe9f8;margin-top:6px">Illustrative season ` +
    `splash — live news lands when the intel feed is wired.</div></div>`;

  // Two event cards — SYS event/patch (illustrative).
  const sideCol = document.createElement("div");
  Object.assign(sideCol.style, {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  sideCol.innerHTML =
    eventCard("var(--glow)", "var(--edge)", "SYS · EVENT", "Packet Storm Weekend", "Illustrative event slot") +
    eventCard("#fbbf24", "var(--warn)", "SYS · PATCH", "Trojan rebalance", "Illustrative patch slot");

  grid.append(featured, sideCol);
  wrap.append(header, grid);
  return wrap;
}

/** A single illustrative INTEL event card (static markup only). */
function eventCard(
  top: string,
  bottom: string,
  tag: string,
  title: string,
  blurb: string,
): string {
  return (
    `<div style="flex:1;position:relative;background:var(--panel,#111c30);` +
    `border:1px solid rgba(95,200,245,0.14);clip-path:${chamfer(10)};` +
    `padding:14px 16px;display:flex;flex-direction:column;justify-content:center" ` +
    `title="Illustrative — events are not yet wired to a backend.">` +
    `<div style="position:absolute;left:0;top:8px;bottom:8px;width:3px;` +
    `background:linear-gradient(180deg,${top},${bottom})"></div>` +
    `<span style="font-family:${FONT.mono};font-size:9px;letter-spacing:0.12em;` +
    `color:${top}">${tag}</span>` +
    `<div style="font-family:${FONT.display};font-weight:700;font-size:13px;` +
    `color:var(--text);margin-top:5px">${title}</div>` +
    `<div style="font-size:10px;color:var(--faint);margin-top:3px">${blurb}</div></div>`
  );
}

/**
 * The right SQUAD panel — STATIC ILLUSTRATIVE friends list (no backend). It shows
 * the locked empty-state copy (`NO AGENTS ONLINE` + a display-only `+ ADD AGENT`)
 * AND a clearly-labelled SYS sample roster so the founder's chosen illustrative
 * chrome reads as "what this will look like," never as live telemetry. Static
 * markup only (no caller input).
 */
function renderSquadPanel(): HTMLElement {
  const panel = el("aside", "fw-hub-squad");
  Object.assign(panel.style, {
    width: "262px",
    flex: "none",
    background: "linear-gradient(180deg,#0d1626,#0a1220)",
    borderLeft: "1px solid rgba(95,200,245,0.14)",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  const head = document.createElement("div");
  Object.assign(head.style, {
    padding: "20px 20px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid rgba(95,200,245,0.1)",
  } satisfies Partial<CSSStyleDeclaration>);
  head.innerHTML =
    `<span style="font-family:${FONT.display};font-weight:700;font-size:13px;` +
    `color:var(--text);letter-spacing:0.06em">SQUAD</span>` +
    // No backend → muted "—" online count (never an invented number).
    `<span style="font-family:${FONT.mono};font-size:10px;color:var(--faint)">— ONLINE</span>`;

  const body = document.createElement("div");
  Object.assign(body.style, {
    padding: "14px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: "1",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  body.title = "Illustrative — the squad list is not yet wired to a backend.";
  body.innerHTML =
    `<div style="font-family:${FONT.mono};font-size:9px;letter-spacing:0.14em;` +
    `color:var(--faint);padding:4px 6px">// ILLUSTRATIVE · NO AGENTS ONLINE</div>` +
    squadRow("var(--accent)", "GH0ST_BYTE", "▸ Ranked · breaching", true) +
    squadRow("var(--ready)", "R00T_KIT", "In lobby", false) +
    squadRow("var(--warn)", "CIPH3R", "Away", false);

  const foot = document.createElement("div");
  Object.assign(foot.style, {
    padding: "14px",
    borderTop: "1px solid rgba(95,200,245,0.1)",
  } satisfies Partial<CSSStyleDeclaration>);
  // Display-only `+ ADD AGENT` (locked empty-state copy; no wiring).
  foot.innerHTML =
    `<div style="padding:11px;text-align:center;border:1px dashed rgba(95,200,245,0.25);` +
    `clip-path:${chamfer(8)};font-family:${FONT.display};font-size:11px;` +
    `letter-spacing:0.06em;color:var(--text-2)" title="Illustrative — adding agents is not yet wired.">` +
    `+ ADD AGENT</div>`;

  panel.append(head, body, foot);
  return panel;
}

/** A single illustrative SQUAD roster row (static markup only). */
function squadRow(
  dot: string,
  name: string,
  status: string,
  active: boolean,
): string {
  const wrap = active
    ? `position:relative;background:rgba(34,211,238,0.08);clip-path:polygon(0 0,100% 0,100% 100%,7px 100%,0 calc(100% - 7px));`
    : "";
  const bar = active
    ? `<div style="position:absolute;left:0;top:4px;bottom:4px;width:2px;background:var(--glow)"></div>`
    : "";
  const statusColor = active ? "var(--glow)" : "var(--faint)";
  return (
    `<div style="${wrap}display:flex;align-items:center;gap:11px;padding:9px 10px">` +
    `${bar}` +
    `<div style="position:relative"><div style="width:34px;height:34px;` +
    `clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);` +
    `background:linear-gradient(135deg,#334155,#1e293b)"></div>` +
    `<span${active ? ' class="fw-live-dot"' : ""} style="position:absolute;` +
    `bottom:-1px;right:-1px;width:9px;height:9px;background:${dot};` +
    `border-radius:50%;border:2px solid #0d1626"></span></div>` +
    `<div style="flex:1;min-width:0"><div style="font-size:12px;color:var(--text);` +
    `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</div>` +
    `<div style="font-family:${FONT.mono};font-size:9px;color:${statusColor}">${status}</div></div></div>`
  );
}

/** The empty-state card (NO OPEN ROOMS / Be the first to deploy.). */
function renderEmptyState(onCreate: () => void): HTMLElement {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-sm)",
    padding: "var(--space-3xl) var(--space-lg)",
    background: "var(--surface)",
    border: "1px dashed var(--line)",
    clipPath: chamfer(12),
    textAlign: "center",
  } satisfies Partial<CSSStyleDeclaration>);

  const heading = document.createElement("div");
  Object.assign(heading.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "16px",
    letterSpacing: "0.08em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  heading.textContent = "NO OPEN ROOMS"; // exact copy.

  const sub = document.createElement("div");
  Object.assign(sub.style, {
    fontSize: "12px",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  sub.textContent = "Be the first to deploy."; // exact copy.

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "fw-btn-primary";
  cta.textContent = "CREATE ROOM";
  cta.style.marginTop = "var(--space-sm)";
  cta.addEventListener("click", onCreate);

  wrap.append(heading, sub, cta);
  return wrap;
}

/** A full-bleed modal overlay (slate scrim). */
function modalOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.className = "fw-overlay-backdrop";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(6, 20, 31, 0.78)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--space-lg)",
    zIndex: "1000",
  } satisfies Partial<CSSStyleDeclaration>);
  return overlay;
}

/** A centered modal card on the field (chamfered Meshed frame). */
function modalCard(): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "fw-overlay-card";
  Object.assign(card.style, {
    width: "420px",
    maxWidth: "100%",
    background: "var(--surface)",
    border: "1px solid rgba(95,200,245,0.22)",
    clipPath: chamfer(12),
    padding: "var(--space-lg)",
  } satisfies Partial<CSSStyleDeclaration>);
  return card;
}

/** A labelled text input themed to the palette. */
function textInput(placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  Object.assign(input.style, {
    width: "100%",
    padding: "12px var(--space-md)",
    background: "var(--bg-deep)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: "13px",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-3)",
  } satisfies Partial<CSSStyleDeclaration>);
  return input;
}

/** A ghost (secondary) button. */
function ghostButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fw-btn-ghost";
  b.textContent = label;
  return b;
}

/** Small typed `createElement` helper that sets a class name. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
