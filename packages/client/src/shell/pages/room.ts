import { convexMatchSession } from "../net/matchSession.js";
import {
  toggleReady as convexToggleReady,
  type ConvexNetHandlers,
} from "../../net/convexClient.js";
import { chamfer, angledTab, edgeBar, circuitRail } from "../meshed.js";

/**
 * Lobby Room / Ready page (Meshed "Lobby Room", UI-SPEC #5) — the pre-match
 * staging surface, restyled to the Meshed System foundation in Phase 6 (06-06,
 * MESHED-C). On CONVEX (Phase 9, plan 08) the page drives off the REACTIVE
 * `api.match.get` subscription (`convexMatchSession.subscribe`); the lobby already
 * seated the caller (the `createRoom`/`joinMatch` mutation) and stored the matchId
 * on `convexMatchSession` before navigating here, so this page does NOT re-join — it
 * just subscribes to the reactive doc and renders. The page visuals/copy are
 * UNCHANGED from the Colyseus version; only the data wiring moved.
 *
 * What it renders off the reactive doc's synced state:
 *   - Two team columns of chamfered slot cards: a filled slot shows the PUBLIC
 *     `displayName` + a ready pip (green ready / red not-ready) + a YOU badge on
 *     the local seat (the caller's `localMobileId`, surfaced via onLocalIdentity);
 *     an empty slot is a dashed OPEN SLOT. Slots show `displayName` ONLY — never an
 *     account id (Blocker 1; accountId is stripped server-side, R2).
 *   - A per-player `✓ READY` toggle that calls the `toggleReady` mutation (the
 *     server handles auto-start via shouldAutoStart; there is NO manual Start button).
 *   - A room-config rail (mode + the single map option, display-only).
 *   - An auto-start STATUS LINE: STARTING WHEN ALL READY… when full + all ready,
 *     WAITING ON {N} AGENT(S) otherwise.
 *
 * Per the founder's STATIC-ILLUSTRATIVE policy, no-backend fields (class, rank,
 * level, ping, region, map art) are rendered as clearly-labelled illustrative
 * chrome — never presented as live state. Sourceless numerics use a muted "—".
 *
 * Entering `/play` happens automatically when the server flips `phase` out of
 * WAITING (server auto-start). The matchId is already on `convexMatchSession`, so the
 * play page (plan 08) detects the Convex route and drives off the same subscription.
 * BACK calls `convexMatchSession.leaveCurrent()` (the `leaveMatch` mutation +
 * unsubscribe) — the ONLY place the match is left from this page.
 */

/**
 * The synced Mobile shape this page reads — a structural subset of the mapped
 * `SyncedMobile` from convexDocToSyncedState (the mapper carries displayName + ready
 * + connected through for exactly this page, plan 08).
 */
interface SyncedMobile {
  sessionId: string;
  team: number;
  /** PUBLIC handle (Blocker 1) — the only identity field that crosses the wire. */
  displayName: string;
  ready: boolean;
  connected: boolean;
}

/** The synced MatchState shape this page reads (read-only mirror of the mapped state). */
interface SyncedState {
  phase: string;
  mobiles: {
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
    size: number;
  };
}

/**
 * Render the room page into `root`. Returns a cleanup fn. NOTE: cleanup does NOT
 * leave the match — that would forfeit a seat on every nav within the match flow
 * (room→play). A real back-to-lobby is the explicit BACK control, which calls
 * `convexMatchSession.leaveCurrent()` then navigates.
 */
export function renderRoom(
  root: HTMLElement,
  roomId: string,
  navigate: (path: string) => void,
): () => void {
  root.innerHTML = "";

  let disposed = false;
  /** True once the reactive subscription is live (enables the READY toggle). */
  let subscribed = false;
  /** Our own seat id (localMobileId) once known — drives the READY toggle + YOU badge. */
  let mySessionId = "";
  /** Local mirror of whether WE are ready (optimistic, reconciled by patches). */
  let iAmReady = false;
  /** Guard so the room→play navigation fires exactly once. */
  let navigatedToPlay = false;

  const cleanup = (): void => {
    disposed = true;
  };

  // ── page shell ────────────────────────────────────────────────────────────
  const page = el("div", "fw-room");
  Object.assign(page.style, {
    minHeight: "100%",
    position: "relative",
    background: "var(--bg-deeper)",
    fontFamily: "var(--font-body)",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  // Field texture: radial wash + the Meshed diagonal hatch (static chrome).
  const fieldWash = document.createElement("div");
  Object.assign(fieldWash.style, {
    position: "absolute",
    inset: "0",
    background:
      "radial-gradient(120% 70% at 50% -10%, var(--bg-deep), var(--bg-deeper) 60%)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const fieldHatch = document.createElement("div");
  Object.assign(fieldHatch.style, {
    position: "absolute",
    inset: "0",
    backgroundImage:
      "repeating-linear-gradient(135deg, rgba(95,200,245,0.015) 0 2px, transparent 2px 6px)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  // ── Room header: back chevron + play glyph + room name + metaline + agents/ping
  const header = el("header", "fw-room-header");
  Object.assign(header.style, {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: "76px",
    gap: "var(--space-md)",
    padding: "0 var(--space-lg)",
    borderBottom: "1px solid var(--line)",
    background:
      "linear-gradient(180deg, rgba(20,40,62,0.6), rgba(8,16,26,0.4))",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);
  // Glowing edge-bar pinned to the panel's left (foundation motif).
  header.insertAdjacentHTML("afterbegin", edgeBar(4, 14));

  // Left cluster: back chevron (the BACK control) + play glyph + title block.
  const headerLeft = document.createElement("div");
  Object.assign(headerLeft.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-md)",
  } satisfies Partial<CSSStyleDeclaration>);

  const back = el("button", "fw-room-back");
  back.type = "button";
  back.setAttribute("aria-label", "Back to lobby");
  back.textContent = "‹";
  Object.assign(back.style, {
    background: "transparent",
    border: "none",
    padding: "4px 8px",
    color: "var(--muted)",
    fontFamily: "var(--font-display)",
    fontSize: "20px",
    lineHeight: "1",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  back.addEventListener("click", () => {
    // A real back-to-lobby frees the seat — THE only leave from this page (the
    // `leaveMatch` mutation + unsubscribe). The room→play auto-advance never reaches
    // here (it navigates directly without leaving). AWAIT the leave before
    // navigating so the seat is freed server-side before the lobby re-lists the
    // room — otherwise the leaver can still appear seated. Guard double-clicks.
    if (back.disabled) return;
    back.disabled = true;
    void (async () => {
      try {
        await convexMatchSession.leaveCurrent();
      } catch (e) {
        console.error("[room] leaveCurrent failed", e);
      } finally {
        cleanup();
        navigate("/lobby");
      }
    })();
  });

  // Play glyph — a cyan triangle, illustrative chrome (no wiring).
  const playGlyph = document.createElement("div");
  Object.assign(playGlyph.style, {
    width: "0",
    height: "0",
    borderTop: "9px solid transparent",
    borderBottom: "9px solid transparent",
    borderLeft: "14px solid var(--glow)",
    filter: "drop-shadow(0 0 5px var(--edge))",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);

  // Title block: room name (Aldrich) + RANKED tag + the mono metaline.
  const titleBlock = document.createElement("div");

  const titleRow = document.createElement("div");
  Object.assign(titleRow.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-sm)",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const title = el("h2", "fw-room-title");
  Object.assign(title.style, {
    margin: "0",
    fontFamily: "var(--font-alt)",
    fontWeight: "400",
    fontSize: "18px",
    letterSpacing: "0.1em",
    color: "var(--text)",
    textShadow: "0 0 12px rgba(95,200,245,0.4)",
  } satisfies Partial<CSSStyleDeclaration>);
  title.textContent = "STAGING ROOM";

  // RANKED tag — illustrative chrome (no ranked backend), angled-tab motif.
  const rankedTag = document.createElement("span");
  Object.assign(rankedTag.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "9px",
    letterSpacing: "0.1em",
    color: "var(--glow)",
    border: "1px solid rgba(95,200,245,0.4)",
    padding: "2px 9px",
    clipPath: angledTab(10),
  } satisfies Partial<CSSStyleDeclaration>);
  rankedTag.textContent = "RANKED";
  rankedTag.title = "Illustrative — ranked tier not yet wired";

  titleRow.append(title, rankedTag);

  // Metaline — illustrative proto/rounds/region; the room id portion is REAL.
  const metaline = document.createElement("div");
  Object.assign(metaline.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--faint)",
    marginTop: "3px",
  } satisfies Partial<CSSStyleDeclaration>);
  // REAL room id (truthful) + illustrative proto/rounds/region suffix. Built via
  // textContent only (no innerHTML with the room id — XSS guard).
  const roomTag = roomId.length > 8 ? `${roomId.slice(0, 8)}…` : roomId;
  metaline.textContent = `room::${roomTag} · proto=— · rounds=— · region=—`;
  metaline.title = "proto/rounds/region are illustrative — not yet wired";

  titleBlock.append(titleRow, metaline);
  headerLeft.append(back, playGlyph, titleBlock);

  // Right cluster: agents-count (REAL once synced) + ping (illustrative).
  const headerRight = document.createElement("div");
  Object.assign(headerRight.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-lg)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--text-2)",
  } satisfies Partial<CSSStyleDeclaration>);

  const agentsCount = document.createElement("span");
  Object.assign(agentsCount.style, {
    display: "flex",
    alignItems: "center",
    gap: "7px",
  } satisfies Partial<CSSStyleDeclaration>);
  const agentsPip = document.createElement("span");
  agentsPip.className = "fw-live-dot"; // live "online" pip — gentle pulse.
  Object.assign(agentsPip.style, {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--ready)",
    boxShadow: "0 0 6px var(--ready)",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);
  // REAL agents count text node — populated from synced state. Starts at "—".
  const agentsCountText = document.createTextNode(" — AGENTS");
  agentsCount.append(agentsPip, agentsCountText);

  // Ping — illustrative (no ping backend); muted "—" per the sourceless rule.
  const ping = document.createElement("span");
  Object.assign(ping.style, {
    color: "var(--faint)",
  } satisfies Partial<CSSStyleDeclaration>);
  ping.textContent = "▱▱▱▱▱ — ms";
  ping.title = "Illustrative — ping not yet measured";

  headerRight.append(agentsCount, ping);
  header.append(headerLeft, headerRight);

  // ── Body: teams panel (map banner + two team columns + VS) | right rail ────
  const body = el("main", "fw-room-body");
  Object.assign(body.style, {
    position: "relative",
    flex: "1",
    display: "flex",
    minHeight: "0",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  // Teams column wrapper (map banner + the two team columns + VS divider).
  const teamsWrap = document.createElement("div");
  Object.assign(teamsWrap.style, {
    flex: "1",
    minWidth: "320px",
    padding: "var(--space-lg) var(--space-lg)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-md)",
  } satisfies Partial<CSSStyleDeclaration>);

  // ── Map banner — illustrative art + display-only CHANGE (single-option stub) ─
  const mapBanner = document.createElement("div");
  Object.assign(mapBanner.style, {
    position: "relative",
    minHeight: "118px",
    overflow: "hidden",
    border: "1px solid rgba(95,200,245,0.22)",
    clipPath: chamfer(14),
    display: "flex",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const mapArt = document.createElement("div");
  Object.assign(mapArt.style, {
    width: "210px",
    minWidth: "160px",
    position: "relative",
    background: "linear-gradient(135deg,#1a2540,#0d1628)",
  } satisfies Partial<CSSStyleDeclaration>);
  // Map-art placeholder label (illustrative — no map-art backend).
  const mapArtLabel = document.createElement("div");
  Object.assign(mapArtLabel.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.12em",
    color: "var(--faint)",
  } satisfies Partial<CSSStyleDeclaration>);
  mapArtLabel.textContent = "MAP ART —";
  const mapCorner = document.createElement("div");
  Object.assign(mapCorner.style, {
    position: "absolute",
    top: "8px",
    left: "8px",
    width: "16px",
    height: "16px",
    borderTop: "2px solid var(--glow)",
    borderLeft: "2px solid var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  mapArt.append(mapArtLabel, mapCorner);

  const mapMeta = document.createElement("div");
  Object.assign(mapMeta.style, {
    flex: "1",
    minWidth: "200px",
    background: "linear-gradient(180deg,#101e30,#0b1422)",
    padding: "var(--space-md) var(--space-lg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-md)",
  } satisfies Partial<CSSStyleDeclaration>);

  const mapMetaText = document.createElement("div");
  const mapKicker = document.createElement("div");
  Object.assign(mapKicker.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.14em",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  mapKicker.textContent = "▸ ACTIVE MAP // map::—";
  const mapName = document.createElement("div");
  Object.assign(mapName.style, {
    fontFamily: "var(--font-alt)",
    fontSize: "22px",
    letterSpacing: "0.06em",
    color: "var(--text)",
    marginTop: "6px",
  } satisfies Partial<CSSStyleDeclaration>);
  mapName.textContent = "DEFAULT"; // single map option (display-only stub).
  const mapSub = document.createElement("div");
  Object.assign(mapSub.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--faint)",
    marginTop: "5px",
  } satisfies Partial<CSSStyleDeclaration>);
  mapSub.textContent = "grav=— · wind=— · cover=—";
  mapSub.title = "Illustrative map params — not yet wired";
  mapMetaText.append(mapKicker, mapName, mapSub);

  // CHANGE control — display-only chrome (single map option; no wiring).
  const mapChange = document.createElement("div");
  Object.assign(mapChange.style, {
    padding: "8px 16px",
    border: "1px solid rgba(95,200,245,0.3)",
    clipPath: angledTab(10),
    fontFamily: "var(--font-alt)",
    fontSize: "11px",
    color: "var(--text-2)",
    letterSpacing: "0.08em",
    opacity: "0.6",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);
  mapChange.textContent = "CHANGE";
  mapChange.title = "Single map option — display-only";
  mapMeta.append(mapMetaText, mapChange);
  mapBanner.append(mapArt, mapMeta);

  // ── Two team columns + VS divider ──────────────────────────────────────────
  const teamsRow = document.createElement("div");
  Object.assign(teamsRow.style, {
    flex: "1",
    display: "flex",
    gap: "var(--space-md)",
    minHeight: "0",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const teamACol = teamColumn("◤ BLUE TEAM", "var(--accent)", "left");
  const teamBCol = teamColumn("RED TEAM ◢", "var(--danger)", "right");

  // VS divider (illustrative chrome).
  const vs = document.createElement("div");
  Object.assign(vs.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    paddingTop: "34px",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);
  const vsTop = document.createElement("div");
  Object.assign(vsTop.style, {
    width: "1px",
    flex: "1",
    minHeight: "20px",
    background:
      "linear-gradient(var(--bg-deeper), rgba(95,200,245,0.25), var(--bg-deeper))",
  } satisfies Partial<CSSStyleDeclaration>);
  const vsLabel = document.createElement("div");
  Object.assign(vsLabel.style, {
    fontFamily: "var(--font-alt)",
    fontSize: "16px",
    color: "var(--faint)",
    transform: "skewX(-8deg)",
  } satisfies Partial<CSSStyleDeclaration>);
  vsLabel.textContent = "VS";
  const vsBot = vsTop.cloneNode(true) as HTMLElement;
  vs.append(vsTop, vsLabel, vsBot);

  teamsRow.append(teamACol.col, vs, teamBCol.col);
  teamsWrap.append(mapBanner, teamsRow);

  // ── Right rail: ROOM CONFIG + in-room COMMS (empty-state) ──────────────────
  const rail = el("aside", "fw-room-rail");
  Object.assign(rail.style, {
    width: "328px",
    minWidth: "260px",
    flex: "1",
    borderLeft: "1px solid var(--line-faint)",
    background: "linear-gradient(180deg,#0a1422,var(--bg-deeper))",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  // ROOM CONFIG block (mode + single map option, display-only).
  const configBlock = document.createElement("div");
  Object.assign(configBlock.style, {
    padding: "var(--space-md) var(--space-lg)",
    borderBottom: "1px solid var(--line-faint)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);

  // Section header with the circuit-rail "//" divider motif.
  const configHead = document.createElement("div");
  Object.assign(configHead.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  const configLabel = document.createElement("span");
  Object.assign(configLabel.style, {
    fontFamily: "var(--font-alt)",
    fontSize: "12px",
    letterSpacing: "0.12em",
    color: "var(--text-2)",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);
  configLabel.textContent = "ROOM CONFIG";
  const configRail = document.createElement("span");
  Object.assign(configRail.style, {
    flex: "1",
    display: "flex",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  configRail.insertAdjacentHTML("afterbegin", circuitRail(false));
  configHead.append(configLabel, configRail);

  // Config rows. MODE is derived from the REAL seat count; the rest are
  // illustrative "—" (no rounds/timer/items/wind backend).
  const modeRail = railRow("mode", "—");
  const mapRailCfg = railRow("map", "DEFAULT"); // single-option stub.
  const roundsRail = railRow("rounds", "—");
  const timerRail = railRow("turn_timer", "—");
  const itemsRail = railRow("items", "—");
  [roundsRail, timerRail, itemsRail].forEach((r) => {
    r.row.title = "Illustrative — not yet wired";
  });

  configBlock.append(
    configHead,
    modeRail.row,
    mapRailCfg.row,
    roundsRail.row,
    timerRail.row,
    itemsRail.row,
  );

  // COMMS block — in-room chat EMPTY STATE (no chat backend in v1).
  const commsBlock = document.createElement("div");
  Object.assign(commsBlock.style, {
    flex: "1",
    display: "flex",
    flexDirection: "column",
    minHeight: "0",
  } satisfies Partial<CSSStyleDeclaration>);

  const commsHead = document.createElement("div");
  Object.assign(commsHead.style, {
    padding: "var(--space-md) var(--space-lg) 8px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  const commsLabel = document.createElement("span");
  Object.assign(commsLabel.style, {
    fontFamily: "var(--font-alt)",
    fontSize: "12px",
    letterSpacing: "0.12em",
    color: "var(--text-2)",
  } satisfies Partial<CSSStyleDeclaration>);
  commsLabel.textContent = "COMMS";
  const commsSecure = document.createElement("span");
  Object.assign(commsSecure.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "9px",
    color: "var(--faint)",
  } satisfies Partial<CSSStyleDeclaration>);
  commsSecure.textContent = "// secure";
  commsHead.append(commsLabel, commsSecure);

  // Empty-state body: SYS-voice OFFLINE notice (locked copy).
  const commsBody = document.createElement("div");
  Object.assign(commsBody.style, {
    flex: "1",
    minHeight: "80px",
    padding: "0 var(--space-lg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    letterSpacing: "0.1em",
    color: "var(--faint)",
    textAlign: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  commsBody.textContent = "COMMS OFFLINE";

  // Disabled composer (faint placeholder; no send wiring in v1).
  const composerRow = document.createElement("div");
  Object.assign(composerRow.style, {
    padding: "var(--space-md) var(--space-lg)",
    display: "flex",
    gap: "8px",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  const composer = document.createElement("div");
  Object.assign(composer.style, {
    flex: "1",
    minHeight: "36px",
    background: "rgba(17,28,48,0.7)",
    border: "1px solid var(--line-faint)",
    clipPath:
      "polygon(0 7px,7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%)",
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--faint)",
    opacity: "0.6",
  } satisfies Partial<CSSStyleDeclaration>);
  composer.textContent = "> comms disabled";
  composer.setAttribute("aria-disabled", "true");
  const composerSend = document.createElement("div");
  Object.assign(composerSend.style, {
    width: "36px",
    height: "36px",
    background: "rgba(27,159,224,0.14)",
    border: "1px solid rgba(95,200,245,0.35)",
    clipPath:
      "polygon(0 0,100% 0,100% 100%,7px 100%,0 calc(100% - 7px))",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--glow)",
    opacity: "0.5",
  } satisfies Partial<CSSStyleDeclaration>);
  composerSend.textContent = "▸";
  composerRow.append(composer, composerSend);

  commsBlock.append(commsHead, commsBody, composerRow);
  rail.append(configBlock, commsBlock);

  body.append(teamsWrap, rail);

  // ── Footer action bar: status line + ready toggle (NO manual Start button) ─
  const footer = el("footer", "fw-room-footer");
  Object.assign(footer.style, {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-md)",
    minHeight: "82px",
    padding: "0 var(--space-lg)",
    borderTop: "1px solid var(--line)",
    background:
      "linear-gradient(180deg, rgba(20,40,62,0.5), rgba(8,16,26,0.6))",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const statusLine = el("div", "fw-room-status");
  Object.assign(statusLine.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    letterSpacing: "0.04em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  statusLine.textContent = "CONNECTING…";

  const readyBtn = el("button", "fw-room-ready");
  readyBtn.type = "button";
  readyBtn.textContent = "✓ READY"; // exact copy — the focal toggle.
  readyBtn.disabled = true;
  styleReadyButton(readyBtn, false);
  readyBtn.addEventListener("click", () => {
    if (!subscribed) return;
    // Toggle: call the Convex `toggleReady(matchId, ready)` mutation (the server
    // auto-starts via shouldAutoStart when full + all ready — no manual master
    // Start). Optimistic flip; the reactive doc patch reconciles the authoritative
    // value back through renderState. Fire-and-forget; revert the optimistic flip if
    // the mutation rejects (e.g. no longer WAITING).
    const next = !iAmReady;
    iAmReady = next;
    styleReadyButton(readyBtn, iAmReady);
    void convexToggleReady(roomId, next).catch((e: unknown) => {
      if (disposed) return;
      iAmReady = !next; // revert the optimistic flip on rejection.
      styleReadyButton(readyBtn, iAmReady);
      console.error("[room] toggleReady failed", e);
    });
  });

  footer.append(statusLine, readyBtn);

  page.append(fieldWash, fieldHatch, header, body, footer);
  root.appendChild(page);

  // ── render the slots + status off a synced patch ──────────────────────────
  function renderState(state: SyncedState): void {
    // Auto-enter /play when the server flips phase out of WAITING (server auto-start
    // via shouldAutoStart). The matchId is already on convexMatchSession, so the play
    // page detects the Convex route and drives off the same subscription — no re-join.
    //
    // Use an ALLOWLIST of the real in-match phases (undefined, "", and "WAITING" all
    // stay on the staging room) so an early/empty patch never flips a freshly CREATED
    // WAITING room straight into /play.
    const inMatch =
      state.phase === "TURN_START" ||
      state.phase === "AIMING" ||
      state.phase === "RESOLVING" ||
      state.phase === "RESULTS";
    if (inMatch && !navigatedToPlay) {
      navigatedToPlay = true;
      navigate(`/play/${encodeURIComponent(roomId)}`);
      return;
    }

    // `mobiles` (a MapSchema) is undefined until the first patch decodes — same
    // @colyseus/schema reflection gap as `phase`. The immediate renderState() call
    // right after join() can hit this; bail until it exists (the onStateChange
    // patch re-calls us once the seat list syncs). A bare `.forEach` here threw
    // "Cannot read properties of undefined" → caught as a false "COULD NOT JOIN".
    if (!state.mobiles) {
      statusLine.textContent = "CONNECTING…";
      return;
    }

    const teamA: SyncedMobile[] = [];
    const teamB: SyncedMobile[] = [];
    let readyCount = 0;
    state.mobiles.forEach((m) => {
      if (m.ready) readyCount++;
      if (m.team === 0) teamA.push(m);
      else teamB.push(m);
    });
    const total = state.mobiles.size;

    // Derive the per-team capacity from the larger occupied side (the room caps
    // seats server-side; we render at least the occupied count so every filled
    // slot shows). Defaults to 1 per side until peers appear.
    const perTeam = Math.max(1, teamA.length, teamB.length);
    const seats = perTeam * 2;

    renderSlots(teamACol.slots, teamA, perTeam, "var(--accent)", mySessionId);
    renderSlots(teamBCol.slots, teamB, perTeam, "var(--danger)", mySessionId);

    // Team header counts (REAL occupancy / capacity).
    teamACol.countEl.textContent = `${teamA.length}/${perTeam}`;
    teamBCol.countEl.textContent = `${teamB.length}/${perTeam}`;

    // Header agents count (REAL) — replaces the leading "—" placeholder.
    agentsCountText.textContent = ` ${total}/${seats} AGENTS`;

    // Mode rail (display-only) derived from the seat count: 2→1v1, 4→2v2, 8→4v4.
    const modeText = seats >= 8 ? "4V4" : seats >= 4 ? "2V2" : "1V1";
    modeRail.valueEl.textContent = modeText;

    // Reconcile MY ready flag from the synced state (authoritative).
    if (mySessionId) {
      let mine = false;
      state.mobiles.forEach((m) => {
        if (m.sessionId === mySessionId) mine = m.ready;
      });
      iAmReady = mine;
      styleReadyButton(readyBtn, iAmReady);
    }

    // Auto-start status line (exact copy). Full + all ready → STARTING WHEN ALL
    // READY…; otherwise WAITING ON {N} AGENT(S) where N is the not-ready /
    // not-yet-seated count.
    const full = total >= seats;
    if (full && readyCount === total && total > 0) {
      statusLine.textContent = "STARTING WHEN ALL READY…";
      statusLine.style.color = "var(--ready)";
    } else {
      const waiting = full ? total - readyCount : seats - readyCount;
      const n = Math.max(1, waiting);
      statusLine.textContent = `WAITING ON ${n} AGENT(S)`;
      statusLine.style.color = "var(--muted)";
    }
  }

  // ── subscribe to the WAITING match's reactive doc (Convex, plan 08) ──────────
  // The lobby already seated the caller (createRoom/joinMatch) and stored the matchId
  // on convexMatchSession, so this page does NOT re-join — it (re-)subscribes to the
  // reactive `api.match.get` doc and renders. onLocalIdentity surfaces the caller's
  // own seat id (localMobileId — the Convex replacement for room.sessionId) for the
  // READY toggle + YOU badge. onStateChange delivers the mapped SyncedState (which the
  // mapper carries displayName + ready + connected through for this page).
  const handlers: ConvexNetHandlers = {
    onShotResult: () => {},
    onTerrainSnapshot: () => {},
    onMatchEnded: () => {},
    onStateChange: (s) => {
      if (disposed) return;
      renderState(s as SyncedState);
    },
    onLocalIdentity: (localMobileId) => {
      if (disposed) return;
      mySessionId = localMobileId;
    },
  };

  try {
    // subscribe is idempotent on the same matchId — re-subscribing to the match we
    // are already in (set by the lobby) re-binds these handlers (no seat, so cheap).
    convexMatchSession.subscribe(roomId, handlers);
    subscribed = true;
    readyBtn.disabled = false;
  } catch (e) {
    statusLine.textContent =
      "COULD NOT JOIN — the room rejected the connection.";
    statusLine.style.color = "var(--danger)";
    console.error("[room] subscribe failed", e);
  }

  return cleanup;
}

// ── slot rendering ─────────────────────────────────────────────────────────

/** Render a team's slots: filled (handle + ready pip + YOU badge) or dashed OPEN SLOT. */
function renderSlots(
  container: HTMLElement,
  members: SyncedMobile[],
  perTeam: number,
  teamColor: string,
  mySessionId: string,
): void {
  container.innerHTML = "";
  for (let i = 0; i < perTeam; i++) {
    const m = members[i];
    container.appendChild(
      m ? filledSlot(m, teamColor, mySessionId) : openSlot(teamColor),
    );
  }
}

/**
 * A filled Meshed slot card: public displayName (Blocker 1 — never an account id)
 * + ready pip + a YOU badge on the local seat + illustrative class/rank/level meta.
 */
function filledSlot(
  m: SyncedMobile,
  teamColor: string,
  mySessionId: string,
): HTMLElement {
  const isYou = !!mySessionId && m.sessionId === mySessionId;

  const slot = document.createElement("div");
  Object.assign(slot.style, {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    background: isYou
      ? "linear-gradient(90deg,rgba(27,159,224,0.1),rgba(11,20,34,0.6))"
      : "rgba(17,28,48,0.6)",
    border: isYou
      ? `1px solid ${teamColor}`
      : "1px solid var(--line-faint)",
    clipPath: chamfer(8),
    padding: "11px 14px",
  } satisfies Partial<CSSStyleDeclaration>);

  // YOUR seat gets the glowing edge-bar motif (parent is position:relative).
  if (isYou) {
    slot.insertAdjacentHTML("afterbegin", edgeBar(3, 6));
  }

  // Hex avatar tile (illustrative — no avatar backend).
  const avatar = document.createElement("div");
  Object.assign(avatar.style, {
    width: "44px",
    height: "44px",
    flex: "0 0 auto",
    clipPath: "polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)",
    background: isYou
      ? `linear-gradient(135deg, ${teamColor}, #0e7490)`
      : "linear-gradient(135deg,#334155,#1e293b)",
  } satisfies Partial<CSSStyleDeclaration>);

  const info = document.createElement("div");
  Object.assign(info.style, { flex: "1", minWidth: "0" } satisfies Partial<CSSStyleDeclaration>);

  const nameRow = document.createElement("div");
  Object.assign(nameRow.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const name = document.createElement("span");
  Object.assign(name.style, {
    fontFamily: "var(--font-cond, var(--font-body))",
    fontWeight: "600",
    fontSize: "15px",
    color: "var(--text)",
    opacity: m.connected ? "1" : "0.5",
  } satisfies Partial<CSSStyleDeclaration>);
  // PUBLIC handle ONLY (Blocker 1) — via textContent (never innerHTML; XSS guard).
  name.textContent = m.displayName || "AGENT";

  // Rank chip — illustrative (no rank backend); muted "—".
  const rankChip = document.createElement("span");
  Object.assign(rankChip.style, {
    fontSize: "9px",
    color: "var(--violet-2)",
    opacity: "0.7",
  } satisfies Partial<CSSStyleDeclaration>);
  rankChip.textContent = "◆ —";
  rankChip.title = "Illustrative — rank tier not yet wired";

  nameRow.append(name, rankChip);

  // YOU badge on the local seat (derived from the synced sessionId).
  if (isYou) {
    const youBadge = document.createElement("span");
    Object.assign(youBadge.style, {
      fontFamily: "var(--font-mono)",
      fontSize: "8px",
      color: "var(--glow)",
      border: "1px solid rgba(95,200,245,0.35)",
      padding: "1px 5px",
    } satisfies Partial<CSSStyleDeclaration>);
    youBadge.textContent = "YOU";
    nameRow.append(youBadge);
  }

  // Meta line — illustrative level/class (muted "—"; never invented numbers).
  const meta = document.createElement("div");
  Object.assign(meta.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    color: "var(--faint)",
    marginTop: "3px",
  } satisfies Partial<CSSStyleDeclaration>);
  meta.textContent = "lvl— · class=—";
  meta.title = "Illustrative — level/class not yet wired";

  info.append(nameRow, meta);

  // Ready state cluster: pip + label (color paired with the label so state reads
  // without color perception).
  const stateCluster = document.createElement("span");
  Object.assign(stateCluster.style, {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.08em",
    flex: "0 0 auto",
    color: m.ready ? "var(--ready)" : "var(--danger)",
  } satisfies Partial<CSSStyleDeclaration>);

  const pip = document.createElement("span");
  // A READY (green) pip is "live" — gentle pulse; NOT-READY (red) stays static.
  if (m.ready) pip.className = "fw-live-dot";
  Object.assign(pip.style, {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flex: "0 0 auto",
    background: m.ready ? "var(--ready)" : "var(--danger)",
    boxShadow: m.ready ? "0 0 8px var(--ready)" : "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const stateLabel = document.createElement("span");
  stateLabel.textContent = m.ready ? "READY" : "NOT READY";

  stateCluster.append(pip, stateLabel);

  slot.append(avatar, info, stateCluster);
  return slot;
}

/** An empty, dashed Meshed OPEN SLOT. */
function openSlot(teamColor: string): HTMLElement {
  const slot = document.createElement("div");
  Object.assign(slot.style, {
    flex: "1",
    minHeight: "58px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    background: "transparent",
    border: `1px dashed ${teamColor}`,
    clipPath: chamfer(8),
    color: "var(--faint)",
    fontFamily: "var(--font-alt)",
    fontSize: "11px",
    letterSpacing: "0.1em",
  } satisfies Partial<CSSStyleDeclaration>);
  const plus = document.createElement("span");
  Object.assign(plus.style, {
    fontSize: "16px",
    color: teamColor,
  } satisfies Partial<CSSStyleDeclaration>);
  plus.textContent = "+";
  const label = document.createElement("span");
  label.textContent = "OPEN SLOT"; // exact copy.
  slot.append(plus, label);
  return slot;
}

// ── primitives ───────────────────────────────────────────────────────────────

/** A team column (angled-tab header w/ label + count, + a slots container). */
function teamColumn(
  label: string,
  color: string,
  skew: "left" | "right",
): { col: HTMLElement; slots: HTMLElement; countEl: HTMLElement } {
  const col = document.createElement("div");
  Object.assign(col.style, {
    flex: "1",
    minWidth: "240px",
    display: "flex",
    flexDirection: "column",
    gap: "9px",
  } satisfies Partial<CSSStyleDeclaration>);

  // Angled-tab header strip (parallelogram chrome).
  const headWrap = document.createElement("div");
  Object.assign(headWrap.style, {
    position: "relative",
    minHeight: "34px",
  } satisfies Partial<CSSStyleDeclaration>);
  const headFill = document.createElement("div");
  Object.assign(headFill.style, {
    position: "absolute",
    inset: "0",
    background: `linear-gradient(180deg, ${color}55, rgba(13,40,64,0.4))`,
    border: `1px solid ${color}`,
    clipPath:
      skew === "left"
        ? "polygon(0 0,100% 0,calc(100% - 22px) 100%,0 100%)"
        : "polygon(22px 0,100% 0,100% 100%,0 100%)",
    opacity: "0.85",
  } satisfies Partial<CSSStyleDeclaration>);
  const headRow = document.createElement("div");
  Object.assign(headRow.style, {
    position: "relative",
    height: "100%",
    minHeight: "34px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    flexDirection: skew === "left" ? "row" : "row-reverse",
  } satisfies Partial<CSSStyleDeclaration>);
  const headLabel = document.createElement("span");
  Object.assign(headLabel.style, {
    fontFamily: "var(--font-alt)",
    fontSize: "13px",
    letterSpacing: "0.14em",
    color: "var(--text-2)",
  } satisfies Partial<CSSStyleDeclaration>);
  headLabel.textContent = label;
  const countEl = document.createElement("span");
  Object.assign(countEl.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    color: color,
  } satisfies Partial<CSSStyleDeclaration>);
  countEl.textContent = "—/—";
  headRow.append(headLabel, countEl);
  headWrap.append(headFill, headRow);

  const slots = document.createElement("div");
  Object.assign(slots.style, {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
  } satisfies Partial<CSSStyleDeclaration>);

  col.append(headWrap, slots);
  return { col, slots, countEl };
}

/** A display-only config-rail row (label + value, mono). */
function railRow(
  label: string,
  value: string,
): { row: HTMLElement; valueEl: HTMLElement } {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
  } satisfies Partial<CSSStyleDeclaration>);
  const l = document.createElement("span");
  Object.assign(l.style, {
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  l.textContent = label;
  const valueEl = document.createElement("span");
  Object.assign(valueEl.style, {
    color: value === "—" ? "var(--faint)" : "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  valueEl.textContent = value;
  row.append(l, valueEl);
  return { row, valueEl };
}

/** Style the READY toggle by current state (green when ready), chamfered. */
function styleReadyButton(btn: HTMLButtonElement, ready: boolean): void {
  Object.assign(btn.style, {
    padding: "15px 30px",
    background: ready ? "rgba(34,197,94,0.18)" : "rgba(34,197,94,0.08)",
    color: "var(--ready)",
    fontFamily: "var(--font-alt)",
    fontWeight: "400",
    fontSize: "13px",
    letterSpacing: "0.08em",
    border: "1px solid rgba(34,197,94,0.5)",
    clipPath: chamfer(10),
    borderRadius: "0",
    cursor: btn.disabled ? "not-allowed" : "pointer",
    opacity: btn.disabled ? "0.5" : "1",
  } satisfies Partial<CSSStyleDeclaration>);
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
