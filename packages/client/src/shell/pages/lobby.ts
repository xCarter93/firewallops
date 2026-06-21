import { getToken, mountUserButton, SERVER_HTTP_URL } from "../auth.js";
import type { NetHandlers } from "../../net/room.js";
import { matchSession } from "../net/matchSession.js";
import {
  subscribeLobby,
  type LobbyRoomEntry,
  type LobbySubscription,
} from "../net/lobbyClient.js";

/**
 * Lobby / Home Hub page (Design screen 03, UI-SPEC #4) — the discovery surface
 * (Phase 5, Plan 08, LOBBY-01/02/03 + AUTH-02/04).
 *
 * Trimmed to v0 scope (UI-SPEC scope-trim): a live LobbyRoom-driven room browser
 * (create/join), the player's profile block (display name + W/L only), and the
 * first-login handle prompt. OMITTED per scope-trim: credits/KEYS/STORE/economy,
 * XP/rank/season/INTEL FEED, SQUAD/friends. The map is a single-option stub.
 *
 * Connections:
 *   - The live room list comes from `subscribeLobby` (a SEPARATE light LobbyRoom
 *     connection — NOT a match seat).
 *   - CREATE ROOM creates a MatchRoom THROUGH the single-owner `matchSession`
 *     (Blocker 3), then navigates to `/room/:id` (the room page rejoins that same
 *     connection idempotently — no second seat).
 *   - The profile block + handle write hit the DISTINCT REST Meta-API
 *     (`SERVER_HTTP_URL` + `/internal/profile`) with the Clerk Bearer token.
 *   - LOG OUT is the mounted Clerk `UserButton` (AUTH-02).
 *
 * Lifecycle: `renderLobby` returns a cleanup fn the router can call on nav-away;
 * it also self-cleans on navigation via the page's own `navigate` wrapper so the
 * lobby subscription never leaks a connection.
 */

/** The profile row shape returned by `GET /internal/profile` (Convex account row or null). */
interface ProfileRow {
  display_name?: string;
  wins?: number;
  losses?: number;
}

/** The selectable match modes (LOBBY-03) — the only real v0 room knob. */
const MODES = ["1v1", "2v2", "4v4"] as const;
type Mode = (typeof MODES)[number];

/**
 * Minimal net handlers for the CREATE-ROOM connection. The lobby only needs the
 * room CREATED on the single-owner matchSession; the real per-patch handlers are
 * supplied by the room page when it rejoins this same room idempotently (Blocker
 * 3). These are inert no-ops so creating a room never throws on an early patch.
 */
const inertHandlers: NetHandlers = {
  onShotResult: () => {},
  onTerrainSnapshot: () => {},
  onMatchEnded: () => {},
  onStateChange: () => {},
};

/**
 * Read the player's profile (display name + W/L) over the DISTINCT REST base with
 * the Clerk Bearer token. Returns the row, or `null` if the account has no row /
 * no display name yet (drives the first-login handle prompt). Throws on a network
 * / auth failure so the caller can show a retry affordance.
 */
async function fetchProfile(): Promise<ProfileRow | null> {
  const token = await getToken();
  const res = await fetch(`${SERVER_HTTP_URL}/internal/profile`, {
    headers: { Authorization: `Bearer ${token ?? ""}` },
  });
  if (!res.ok) {
    throw new Error(`profile read failed: ${res.status}`);
  }
  return (await res.json()) as ProfileRow | null;
}

/**
 * Write the chosen handle to `accounts.display_name` via the Bearer POST
 * (AUTH-04). The accountId is derived server-side from the verified token `sub`,
 * never the body. Throws on a non-2xx so the modal can surface the failure.
 */
async function saveHandle(displayName: string): Promise<void> {
  const token = await getToken();
  const res = await fetch(`${SERVER_HTTP_URL}/internal/profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? ""}`,
    },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    throw new Error(`handle write failed: ${res.status}`);
  }
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

  // ── page shell ──────────────────────────────────────────────────────────
  const page = el("div", "fw-lobby");
  Object.assign(page.style, {
    minHeight: "100%",
    background: "var(--bg)",
    fontFamily: "var(--font-body)",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  // ── top bar: brand · profile (display name + W/L) · Clerk UserButton ──────
  const topbar = el("header", "fw-lobby-topbar");
  Object.assign(topbar.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: "64px",
    padding: "0 var(--space-lg)",
    borderBottom: "1px solid var(--line-faint)",
    background: "var(--bg-deep)",
  } satisfies Partial<CSSStyleDeclaration>);

  const brand = el("div", "fw-brand");
  Object.assign(brand.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "17px",
    letterSpacing: "0.08em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  brand.innerHTML = `FIREWALL<span style="color:var(--accent)">OPS</span>`;

  const profileBlock = el("div", "fw-profile");
  Object.assign(profileBlock.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-lg)",
  } satisfies Partial<CSSStyleDeclaration>);

  // Profile = display name + W/L only (scope-trim: no XP/rank/credits).
  const profileText = el("div", "fw-profile-text");
  Object.assign(profileText.style, {
    textAlign: "right",
    lineHeight: "1.3",
  } satisfies Partial<CSSStyleDeclaration>);
  const handleEl = el("div", "fw-profile-handle");
  Object.assign(handleEl.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "13px",
    letterSpacing: "0.06em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  handleEl.textContent = "—";
  const wlEl = el("div", "fw-profile-wl");
  Object.assign(wlEl.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  wlEl.textContent = "W 0 · L 0";
  profileText.append(handleEl, wlEl);

  // Clerk UserButton mount target — provides LOG OUT (AUTH-02).
  const userButtonMount = document.createElement("div");
  userButtonMount.className = "fw-userbutton";

  profileBlock.append(profileText, userButtonMount);
  topbar.append(brand, profileBlock);

  // ── body: center create/hero + room browser ──────────────────────────────
  const body = el("main", "fw-lobby-body");
  Object.assign(body.style, {
    flex: "1",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-lg)",
    padding: "var(--space-xl) var(--space-lg)",
    maxWidth: "880px",
    width: "100%",
    margin: "0 auto",
  } satisfies Partial<CSSStyleDeclaration>);

  // Header row: section title + CREATE ROOM action.
  const listHeader = el("div", "fw-list-header");
  Object.assign(listHeader.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  } satisfies Partial<CSSStyleDeclaration>);

  const listTitle = el("h2", "fw-list-title");
  Object.assign(listTitle.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "18px",
    letterSpacing: "0.06em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  listTitle.textContent = "OPEN ROOMS";

  const createBtn = el("button", "fw-btn-primary");
  createBtn.type = "button";
  createBtn.textContent = "CREATE ROOM"; // exact copy (UI-SPEC).
  createBtn.addEventListener("click", () => openCreateForm());

  listHeader.append(listTitle, createBtn);

  // The live room list container.
  const listEl = el("div", "fw-room-list");
  Object.assign(listEl.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);

  body.append(listHeader, listEl);
  page.append(topbar, body);
  root.appendChild(page);

  // Mount the Clerk user button (LOG OUT).
  mountUserButton(userButtonMount);

  // ── room-list rendering ───────────────────────────────────────────────────
  function renderRooms(rooms: LobbyRoomEntry[]): void {
    listEl.innerHTML = "";

    if (rooms.length === 0) {
      listEl.appendChild(renderEmptyState(() => openCreateForm()));
      return;
    }

    for (const room of rooms) {
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
      display: "flex",
      alignItems: "center",
      gap: "var(--space-md)",
      padding: "14px var(--space-md)",
      background: "var(--surface)",
      border: "1px solid var(--line-faint)",
      borderRadius: "var(--radius-5)",
    } satisfies Partial<CSSStyleDeclaration>);

    const nameEl = el("div", "fw-room-name");
    Object.assign(nameEl.style, {
      flex: "1",
      fontFamily: "var(--font-display)",
      fontWeight: "700",
      fontSize: "13px",
      letterSpacing: "0.04em",
      color: "var(--text)",
    } satisfies Partial<CSSStyleDeclaration>);
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
      borderRadius: "var(--radius-3)",
      cursor: locked ? "not-allowed" : "pointer",
    } satisfies Partial<CSSStyleDeclaration>);
    joinBtn.disabled = locked;
    if (!locked) {
      // Join = navigate to the room page (it joins the MatchRoom via matchSession).
      joinBtn.addEventListener("click", () =>
        go(`/room/${encodeURIComponent(room.roomId)}`),
      );
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
          const token = await getToken();
          // CREATE ROOM goes THROUGH the single-owner matchSession (Blocker 3).
          const room = await matchSession.create(
            nameInput.value.trim() || "NEW BREACH",
            selectedMode,
            token ?? "",
            inertHandlers,
          );
          overlay.remove();
          go(`/room/${encodeURIComponent(room.roomId)}`);
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
  function openHandlePrompt(): void {
    const overlay = modalOverlay();
    overlay.dataset.blocking = "true";
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
    Object.assign(confirm.style, { width: "100%", justifyContent: "center" });
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

    card.append(title, bodyText, input, err, confirm);
    overlay.appendChild(card);
    root.appendChild(overlay);
    input.focus();
  }

  // ── profile read + handle gate ─────────────────────────────────────────────
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
  void (async () => {
    try {
      const subscription = await subscribeLobby((rooms) => {
        // If the page was torn down (nav-away) before/while a push arrived, close
        // via the stored handle (assigned below once the subscription resolves)
        // and skip the render. Referencing `sub` (not the local const) avoids a
        // temporal-dead-zone self-reference.
        if (disposed) {
          sub?.close();
          return;
        }
        renderRooms(rooms);
      });
      // If we were disposed during the await, close immediately — never store it.
      if (disposed) {
        subscription.close();
        return;
      }
      sub = subscription;
    } catch (e) {
      renderRooms([]);
      console.error("[lobby] room-list subscription failed", e);
    }
  })();
  // Render the empty state immediately (replaced when the first push arrives).
  renderRooms([]);
  void loadProfile();

  return cleanup;
}

// ── shared primitives ────────────────────────────────────────────────────────

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
    borderRadius: "var(--radius-5)",
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

/** A centered modal card on the field. */
function modalCard(): HTMLDivElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "420px",
    maxWidth: "100%",
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-6)",
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
