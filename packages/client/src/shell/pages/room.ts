import type { Room } from "@colyseus/sdk";
import { getToken } from "../auth.js";
import type { NetHandlers } from "../../net/room.js";
import { matchSession } from "../net/matchSession.js";

/**
 * Lobby Room / Ready page (Design screen 04, UI-SPEC #5) — the pre-match staging
 * surface (Phase 5, Plan 08, LOBBY-04, Blocker 1 + Blocker 3).
 *
 * The room page JOINS the WAITING MatchRoom through the SINGLE-OWNER
 * `matchSession.join` (Blocker 3) — never a fresh Colyseus `Client`. That is the
 * SAME connection the play page (plan 09) reuses by reading `matchSession.current`
 * WITHOUT re-joining and WITHOUT leaving, so `/room → /play` is one connection /
 * one seat. The ONLY leave is `matchSession.leaveCurrent()`, called solely when
 * the player truly backs out to the lobby (never on the room→play transition).
 *
 * What it renders off the joined room's synced state:
 *   - Two team columns of slots: a filled slot shows the PUBLIC `displayName` +
 *     a ready pip (green ready / red not-ready); an empty slot is a dashed
 *     OPEN SLOT. Slots show `displayName` ONLY — never an account id (Blocker 1;
 *     no account id crosses the wire).
 *   - A per-player `✓ READY` toggle that sends `ready` / `unready` to the joined
 *     MatchRoom (the room handles auto-start; there is NO manual Start button).
 *   - A room-config rail (mode + the single map option, display-only).
 *   - An auto-start STATUS LINE: STARTING WHEN ALL READY… when full + all ready,
 *     WAITING ON {N} AGENT(S) otherwise.
 *
 * Entering `/play` happens automatically when the server flips `phase` out of
 * WAITING; the play page reads `matchSession.current` (Blocker 3).
 */

/** The synced Mobile shape this page reads (server schema mirror, read-only). */
interface SyncedMobile {
  sessionId: string;
  team: number;
  /** PUBLIC handle (Blocker 1) — the only identity field that crosses the wire. */
  displayName: string;
  ready: boolean;
  connected: boolean;
}

/** The synced MatchState shape this page reads (read-only mirror). */
interface SyncedState {
  phase: string;
  mobiles: {
    forEach(cb: (mobile: SyncedMobile, key: string) => void): void;
    size: number;
  };
}

/**
 * Render the room page into `root`. Returns a cleanup fn. NOTE: cleanup does NOT
 * leave the match — that would break the room→play single-connection reuse
 * (Blocker 3). A real back-to-lobby is the explicit BACK control, which calls
 * `matchSession.leaveCurrent()` then navigates.
 */
export function renderRoom(
  root: HTMLElement,
  roomId: string,
  navigate: (path: string) => void,
): () => void {
  root.innerHTML = "";

  let room: Room | null = null;
  let disposed = false;
  /** Our own sessionId once joined — used to drive the local READY toggle. */
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
    background: "var(--bg)",
    fontFamily: "var(--font-body)",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  // Header: back-to-lobby + room title.
  const header = el("header", "fw-room-header");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-md)",
    height: "64px",
    padding: "0 var(--space-lg)",
    borderBottom: "1px solid var(--line-faint)",
    background: "var(--bg-deep)",
  } satisfies Partial<CSSStyleDeclaration>);

  const back = el("button", "fw-room-back");
  back.type = "button";
  back.textContent = "‹ LOBBY";
  Object.assign(back.style, {
    background: "transparent",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-3)",
    padding: "8px 16px",
    color: "var(--muted)",
    fontFamily: "var(--font-display)",
    fontWeight: "600",
    fontSize: "12px",
    letterSpacing: "0.08em",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  back.addEventListener("click", () => {
    // A real back-to-lobby frees the seat — THE only leave (Blocker 3). The
    // room→play transition never reaches here.
    void matchSession.leaveCurrent();
    cleanup();
    navigate("/lobby");
  });

  const title = el("h2", "fw-room-title");
  Object.assign(title.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "16px",
    letterSpacing: "0.06em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  title.textContent = "STAGING ROOM";

  header.append(back, title);

  // Body: two team columns + config rail.
  const body = el("main", "fw-room-body");
  Object.assign(body.style, {
    flex: "1",
    display: "flex",
    gap: "var(--space-lg)",
    padding: "var(--space-xl) var(--space-lg)",
    maxWidth: "960px",
    width: "100%",
    margin: "0 auto",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  // Team A column.
  const teamACol = teamColumn("TEAM A", "var(--accent)");
  // Team B column.
  const teamBCol = teamColumn("TEAM B", "var(--danger)");

  // Config rail (mode + single map option, display-only).
  const rail = el("aside", "fw-room-rail");
  Object.assign(rail.style, {
    width: "240px",
    minWidth: "200px",
    flex: "1",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-md)",
  } satisfies Partial<CSSStyleDeclaration>);

  const railTitle = el("div", "fw-label");
  railTitle.textContent = "ROOM CONFIG";

  const modeRail = railRow("MODE", "—");
  const mapRail = railRow("MAP", "DEFAULT"); // single-option stub.

  rail.append(railTitle, modeRail.row, mapRail.row);

  body.append(teamACol.col, teamBCol.col, rail);

  // Footer: ready toggle + auto-start status line (NO manual Start button).
  const footer = el("footer", "fw-room-footer");
  Object.assign(footer.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-md)",
    padding: "var(--space-md) var(--space-lg)",
    borderTop: "1px solid var(--line-faint)",
    background: "var(--bg-deep)",
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
    if (!room) return;
    // Toggle: send ready / unready to the joined MatchRoom (the room auto-starts
    // when full + all ready — there is no manual master Start).
    if (iAmReady) {
      room.send("unready");
      iAmReady = false;
    } else {
      room.send("ready");
      iAmReady = true;
    }
    styleReadyButton(readyBtn, iAmReady);
  });

  footer.append(statusLine, readyBtn);

  page.append(header, body, footer);
  root.appendChild(page);

  // ── render the slots + status off a synced patch ──────────────────────────
  function renderState(state: SyncedState): void {
    // Auto-enter /play when the server flips phase out of WAITING (Blocker 3:
    // the play page reuses matchSession.current — no re-join, no leave here).
    //
    // GUARD the unsynced default: the @colyseus/schema CLIENT rebuilds state from
    // reflection, where `phase` is UNSYNCED (undefined / "") UNTIL the first patch
    // decodes — NOT the server's = "WAITING" TS initializer. renderState is called
    // once synchronously right after join() (see below) — possibly BEFORE that
    // first patch — so a "!== WAITING" guard sees undefined and flips a freshly
    // CREATED room straight into /play. Use an ALLOWLIST of the real in-match
    // phases instead: undefined, "", and "WAITING" all stay on the staging room.
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

    renderSlots(teamACol.slots, teamA, perTeam, "var(--accent)");
    renderSlots(teamBCol.slots, teamB, perTeam, "var(--danger)");

    // Mode rail (display-only) derived from the seat count: 2→1v1, 4→2v2, 8→4v4.
    modeRail.valueEl.textContent =
      seats >= 8 ? "4V4" : seats >= 4 ? "2V2" : "1V1";

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

  // ── join the WAITING match through the single-owner matchSession (Blocker 3) ─
  const handlers: NetHandlers = {
    onShotResult: () => {},
    onTerrainSnapshot: () => {},
    onMatchEnded: () => {},
    onStateChange: (s) => {
      if (disposed) return;
      renderState(s as SyncedState);
    },
  };

  void (async () => {
    try {
      const token = await getToken();
      // matchSession.join is idempotent on the same room id — if we created this
      // room from the lobby (already current) it reuses that connection / seat
      // and does NOT open a second one (Blocker 3).
      const joined = await matchSession.join(roomId, token ?? "", handlers);
      if (disposed) return;
      room = joined;
      mySessionId = joined.sessionId;
      readyBtn.disabled = false;
      // If a patch already arrived before this assignment, render the current
      // state immediately so the slots are not stuck on CONNECTING.
      renderState(joined.state as unknown as SyncedState);
    } catch (e) {
      statusLine.textContent =
        "COULD NOT JOIN — the room rejected the connection.";
      statusLine.style.color = "var(--danger)";
      console.error("[room] join failed", e);
    }
  })();

  return cleanup;
}

// ── slot rendering ─────────────────────────────────────────────────────────

/** Render a team's slots: filled (handle + ready pip) or dashed OPEN SLOT. */
function renderSlots(
  container: HTMLElement,
  members: SyncedMobile[],
  perTeam: number,
  teamColor: string,
): void {
  container.innerHTML = "";
  for (let i = 0; i < perTeam; i++) {
    const m = members[i];
    container.appendChild(m ? filledSlot(m, teamColor) : openSlot());
  }
}

/** A filled slot: public displayName (Blocker 1 — never an account id) + ready pip. */
function filledSlot(m: SyncedMobile, teamColor: string): HTMLElement {
  const slot = document.createElement("div");
  Object.assign(slot.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-sm)",
    padding: "12px var(--space-md)",
    background: "var(--surface)",
    border: `1px solid ${teamColor}`,
    borderRadius: "var(--radius-5)",
  } satisfies Partial<CSSStyleDeclaration>);

  const pip = document.createElement("span");
  Object.assign(pip.style, {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flex: "0 0 auto",
    // Ready pip: green ready / red not-ready (color paired with the READY/NOT
    // READY label below so state reads without color perception).
    background: m.ready ? "var(--ready)" : "var(--danger)",
    boxShadow: m.ready ? "0 0 8px var(--ready)" : "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const name = document.createElement("div");
  Object.assign(name.style, {
    flex: "1",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "13px",
    letterSpacing: "0.04em",
    color: "var(--text)",
    opacity: m.connected ? "1" : "0.5",
  } satisfies Partial<CSSStyleDeclaration>);
  // PUBLIC handle ONLY (Blocker 1).
  name.textContent = m.displayName || "AGENT";

  const stateLabel = document.createElement("div");
  stateLabel.className = "fw-label";
  stateLabel.textContent = m.ready ? "READY" : "NOT READY";
  stateLabel.style.color = m.ready ? "var(--ready)" : "var(--danger)";

  slot.append(pip, name, stateLabel);
  return slot;
}

/** An empty, dashed OPEN SLOT. */
function openSlot(): HTMLElement {
  const slot = document.createElement("div");
  Object.assign(slot.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "12px var(--space-md)",
    background: "transparent",
    border: "1px dashed var(--line)",
    borderRadius: "var(--radius-5)",
    color: "var(--faint)",
    fontFamily: "var(--font-body)",
    fontWeight: "500",
    fontSize: "11px",
    letterSpacing: "0.14em",
  } satisfies Partial<CSSStyleDeclaration>);
  slot.textContent = "OPEN SLOT"; // exact copy.
  return slot;
}

// ── primitives ───────────────────────────────────────────────────────────────

/** A team column (label + a slots container). */
function teamColumn(
  label: string,
  color: string,
): { col: HTMLElement; slots: HTMLElement } {
  const col = document.createElement("div");
  Object.assign(col.style, {
    flex: "1",
    minWidth: "240px",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);

  const head = document.createElement("div");
  head.className = "fw-label";
  head.textContent = label;
  head.style.color = color;

  const slots = document.createElement("div");
  Object.assign(slots.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);

  col.append(head, slots);
  return { col, slots };
}

/** A display-only config-rail row (label + value). */
function railRow(label: string, value: string): { row: HTMLElement; valueEl: HTMLElement } {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px var(--space-md)",
    background: "var(--surface)",
    border: "1px solid var(--line-faint)",
    borderRadius: "var(--radius-3)",
  } satisfies Partial<CSSStyleDeclaration>);
  const l = document.createElement("span");
  l.className = "fw-label";
  l.textContent = label;
  const valueEl = document.createElement("span");
  Object.assign(valueEl.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--text-2)",
  } satisfies Partial<CSSStyleDeclaration>);
  valueEl.textContent = value;
  row.append(l, valueEl);
  return { row, valueEl };
}

/** Style the READY toggle by current state (green when ready). */
function styleReadyButton(btn: HTMLButtonElement, ready: boolean): void {
  Object.assign(btn.style, {
    padding: "12px 28px",
    background: ready ? "var(--ready)" : "transparent",
    color: ready ? "var(--bg-deeper)" : "var(--ready)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "13px",
    letterSpacing: "0.08em",
    border: "1px solid var(--ready)",
    borderRadius: "var(--radius-3)",
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
