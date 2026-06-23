import { getToken, SERVER_HTTP_URL } from "../auth.js";

/**
 * overlays.ts — reusable DOM overlays for the web-app shell (Phase 5, Plan 09),
 * themed to the founder's Claude Design SOC palette (05-UI-SPEC.md tokens via
 * shell.css custom properties). These are framework-free DOM nodes mounted on top
 * of whatever surface is active (the landing/lobby chrome OR the /play Phaser
 * canvas) — they never touch the canvas itself.
 *
 * Four families (all copy is VERBATIM from the UI-SPEC Copywriting Contract):
 *   1. HANDLE PROMPT     — first-login `CHOOSE YOUR HANDLE`; POSTs the display name
 *                          to the DISTINCT REST base `${SERVER_HTTP_URL}/internal/profile`
 *                          with the Clerk Bearer token → accounts.display_name.
 *   2. SHARE-LINK ERROR  — `ROOM FULL` / `ROOM NOT FOUND` / generic join failure →
 *                          `BROWSE ROOMS` drops to /lobby.
 *   3. RECONNECTION      — self-disconnect (`CONNECTION LOST` + 30s countdown),
 *                          `LINK RESTORED` toast, `LINK LOST — YOU FORFEITED…` terminal.
 *   4. POST-MATCH BANNER — win/loss/draw copy → `RETURN TO LOBBY`.
 *
 * The reconnection window mirrors the server's `allowReconnection` window (RECON,
 * 05-05). The OTHERS-see-you-disconnected rendering (dim mech + badge + turn-list
 * countdown) lives in MatchScene off the synced `mobile.connected` flag — these
 * overlays are the SELF-side + share-link + handle + post-match DOM surfaces.
 */

/** The server-side reconnection window (seconds) — mirrors 05-05 allowReconnection. */
export const RECONNECT_WINDOW_SECONDS = 30;

// ─────────────────────────────────────────────────────────────────────────────
// shared overlay primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A full-bleed dimmed backdrop that captures clicks (modal). */
function backdrop(): HTMLDivElement {
  const bd = document.createElement("div");
  bd.className = "fw-overlay-backdrop";
  Object.assign(bd.style, {
    position: "fixed",
    inset: "0",
    zIndex: "1000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--space-lg)",
    background: "rgba(6, 20, 31, 0.82)",
    backdropFilter: "blur(2px)",
    fontFamily: "var(--font-body)",
  } satisfies Partial<CSSStyleDeclaration>);
  return bd;
}

/** A centered SOC card (the modal body). */
function card(): HTMLDivElement {
  const c = document.createElement("div");
  c.className = "fw-overlay-card";
  Object.assign(c.style, {
    width: "min(440px, 100%)",
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-6)",
    padding: "var(--space-xl)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-md)",
    boxShadow: "0 24px 64px -16px rgba(0,0,0,0.6)",
    textAlign: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  return c;
}

/** An Orbitron screen/banner heading. */
function heading(text: string, color = "var(--text)"): HTMLHeadingElement {
  const h = document.createElement("h2");
  Object.assign(h.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "900",
    fontSize: "22px",
    letterSpacing: "0.04em",
    color,
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  h.textContent = text;
  return h;
}

/** Body copy under a heading. */
function body(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  Object.assign(p.style, {
    fontSize: "13px",
    lineHeight: "1.6",
    color: "var(--text-2)",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  p.textContent = text;
  return p;
}

/** The primary cyan-glow CTA button. */
function primaryButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fw-btn-primary"; // pick up the shared hover/press micro-interaction.
  b.textContent = label;
  Object.assign(b.style, {
    marginTop: "var(--space-sm)",
    padding: "13px 28px",
    background: "var(--accent)",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "13px",
    letterSpacing: "0.08em",
    border: "none",
    borderRadius: "var(--radius-3)",
    cursor: "pointer",
    boxShadow: "0 0 32px -6px rgba(34,211,238,0.6)",
  } satisfies Partial<CSSStyleDeclaration>);
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. HANDLE PROMPT (first login → accounts.display_name)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show the first-login handle prompt. Blocks app entry until a handle is set: the
 * `CONFIRM HANDLE` action POSTs `{ displayName }` to the DISTINCT REST base
 * `${SERVER_HTTP_URL}/internal/profile` with the Clerk Bearer token. On success it
 * removes the overlay and calls `onDone(handle)`; on failure it surfaces an inline
 * error and stays open. Returns a remover so the caller can tear it down.
 */
export function showHandlePrompt(
  onDone: (handle: string) => void,
): () => void {
  const bd = backdrop();
  const c = card();

  const h = heading("CHOOSE YOUR HANDLE", "var(--accent)");
  // Exact UI-SPEC body copy.
  const sub = body(
    "This is the call-sign other agents see. You can change it later.",
  );

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 24;
  input.placeholder = "AGENT_HANDLE";
  input.setAttribute("aria-label", "Your handle");
  Object.assign(input.style, {
    width: "100%",
    padding: "12px var(--space-md)",
    background: "var(--bg-deep)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-3)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    letterSpacing: "0.06em",
    textAlign: "center",
  } satisfies Partial<CSSStyleDeclaration>);

  const errorLine = document.createElement("div");
  errorLine.className = "fw-label";
  Object.assign(errorLine.style, {
    color: "var(--danger)",
    minHeight: "14px",
    letterSpacing: "0.08em",
  } satisfies Partial<CSSStyleDeclaration>);
  errorLine.textContent = "";

  const confirm = primaryButton("CONFIRM HANDLE");

  const remove = (): void => bd.remove();

  const submit = async (): Promise<void> => {
    const displayName = input.value.trim();
    if (displayName.length < 2) {
      errorLine.textContent = "HANDLE TOO SHORT (MIN 2 CHARS)";
      return;
    }
    confirm.disabled = true;
    confirm.style.opacity = "0.6";
    errorLine.textContent = "";
    try {
      const token = await getToken();
      const res = await fetch(`${SERVER_HTTP_URL}/internal/profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) {
        throw new Error(`profile write failed: ${res.status}`);
      }
      remove();
      onDone(displayName);
    } catch (e) {
      console.error("[handle] confirm failed", e);
      errorLine.textContent = "COULD NOT SAVE — TRY AGAIN";
      confirm.disabled = false;
      confirm.style.opacity = "1";
    }
  };

  confirm.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });

  c.append(h, sub, input, errorLine, confirm);
  bd.appendChild(c);
  document.body.appendChild(bd);
  input.focus();
  return remove;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHARE-LINK ERROR (room full / gone / generic join failure)
// ─────────────────────────────────────────────────────────────────────────────

/** The classification of a failed share-link / deep-link join. */
export type JoinErrorKind = "full" | "not-found" | "generic";

/** Map a thrown join error to a kind so the overlay can show the right copy. */
export function classifyJoinError(err: unknown): JoinErrorKind {
  const msg =
    (err instanceof Error ? err.message : String(err ?? "")).toLowerCase() +
    " " +
    // Colyseus errors carry a numeric `code`; surface it for matching.
    String(
      (err as { code?: number } | null)?.code ?? "",
    );
  if (msg.includes("full") || msg.includes("locked") || msg.includes("4002")) {
    return "full";
  }
  if (
    msg.includes("not found") ||
    msg.includes("not_found") ||
    msg.includes("notfound") ||
    msg.includes("4212") ||
    msg.includes("disposed")
  ) {
    return "not-found";
  }
  return "generic";
}

/**
 * Show the share-link error overlay (drops to lobby). Exact UI-SPEC copy per kind.
 * `onBrowse` is the `BROWSE ROOMS` action (the router's navigate("/lobby")).
 */
export function showShareLinkError(
  kind: JoinErrorKind,
  onBrowse: () => void,
): () => void {
  const bd = backdrop();
  const c = card();

  const copy: Record<JoinErrorKind, { title: string; msg: string }> = {
    // VERBATIM from the UI-SPEC Copywriting Contract.
    full: {
      title: "ROOM FULL",
      msg: "ROOM FULL — that breach is at capacity.",
    },
    "not-found": {
      title: "ROOM NOT FOUND",
      msg: "ROOM NOT FOUND — it may have closed.",
    },
    generic: {
      title: "COULD NOT JOIN",
      msg: "COULD NOT JOIN — the room rejected the connection. Try another.",
    },
  };

  const { title, msg } = copy[kind];
  const h = heading(title, "var(--danger)");
  const p = body(msg);
  const browse = primaryButton("BROWSE ROOMS");

  const remove = (): void => bd.remove();
  browse.addEventListener("click", () => {
    remove();
    onBrowse();
  });

  c.append(h, p, browse);
  bd.appendChild(c);
  document.body.appendChild(bd);
  return remove;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RECONNECTION (self-disconnect + countdown / restored toast / forfeited)
// ─────────────────────────────────────────────────────────────────────────────

/** A live self-disconnect overlay with a countdown; returns controls. */
export interface ReconnectingOverlay {
  /** Tick the visible countdown to `seconds` remaining (clamped at 0). */
  setRemaining(seconds: number): void;
  /** Remove the overlay (called on a successful resume). */
  remove(): void;
}

/**
 * Show the SELF disconnect overlay: `CONNECTION LOST — REESTABLISHING LINK…` with
 * the 30s countdown (warning → danger as it nears 0). The caller drives the
 * countdown via `setRemaining` (anchored off the SDK reconnection window) and calls
 * `remove()` on a successful resume (then shows the `LINK RESTORED` toast).
 */
export function showReconnecting(
  initialSeconds = RECONNECT_WINDOW_SECONDS,
): ReconnectingOverlay {
  const bd = backdrop();
  const c = card();

  // Exact UI-SPEC copy.
  const h = heading("CONNECTION LOST", "var(--warn)");
  const p = body("CONNECTION LOST — REESTABLISHING LINK…");

  const count = document.createElement("div");
  Object.assign(count.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "40px",
    fontWeight: "400",
    letterSpacing: "0.04em",
    color: "var(--warn)",
    marginTop: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);

  const format = (s: number): string => {
    const clamped = Math.max(0, Math.ceil(s));
    return `0:${String(clamped).padStart(2, "0")}`;
  };

  const setRemaining = (seconds: number): void => {
    count.textContent = format(seconds);
    // Warning → danger as it nears 0 (UI-SPEC).
    count.style.color = seconds <= 10 ? "var(--danger)" : "var(--warn)";
  };
  setRemaining(initialSeconds);

  c.append(h, p, count);
  bd.appendChild(c);
  document.body.appendChild(bd);

  return { setRemaining, remove: () => bd.remove() };
}

/** Show a brief `LINK RESTORED` toast (auto-dismisses). */
export function showLinkRestored(durationMs = 2200): () => void {
  const toast = document.createElement("div");
  toast.className = "fw-toast";
  Object.assign(toast.style, {
    position: "fixed",
    top: "var(--space-lg)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "1001",
    padding: "10px var(--space-lg)",
    background: "var(--surface)",
    border: "1px solid var(--ready)",
    borderRadius: "var(--radius-3)",
    color: "var(--ready)",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "12px",
    letterSpacing: "0.12em",
    boxShadow: "0 0 24px -6px rgba(34,197,94,0.5)",
  } satisfies Partial<CSSStyleDeclaration>);
  toast.textContent = "LINK RESTORED"; // exact copy
  document.body.appendChild(toast);
  const remove = (): void => toast.remove();
  const t = setTimeout(remove, durationMs);
  return () => {
    clearTimeout(t);
    remove();
  };
}

/**
 * Show the terminal self-forfeit overlay when the reconnection window expires:
 * `LINK LOST — YOU FORFEITED THIS MATCH` → `RETURN TO LOBBY`. `onReturn` tears the
 * match down + returns to the lobby (the caller wires matchSession.leaveCurrent).
 */
export function showForfeited(onReturn: () => void): () => void {
  const bd = backdrop();
  const c = card();

  const h = heading("LINK LOST", "var(--danger)");
  // Exact UI-SPEC copy.
  const p = body("LINK LOST — YOU FORFEITED THIS MATCH");
  const ret = primaryButton("RETURN TO LOBBY");

  const remove = (): void => bd.remove();
  ret.addEventListener("click", () => {
    remove();
    onReturn();
  });

  c.append(h, p, ret);
  bd.appendChild(c);
  document.body.appendChild(bd);
  return remove;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST-MATCH BANNER (win / loss / draw → RETURN TO LOBBY)
// ─────────────────────────────────────────────────────────────────────────────

/** The local player's match outcome (drives the post-match copy). */
export type MatchOutcome = "win" | "loss" | "draw";

/**
 * Show the post-match banner over the final board. Exact UI-SPEC copy per outcome
 * (`BREACH SUCCESSFUL` / `BREACH FAILED` / `STALEMATE — NO BREACH`) → a single
 * `RETURN TO LOBBY` action. `onReturn` tears down Phaser + leaves the match.
 */
export function showPostMatch(
  outcome: MatchOutcome,
  onReturn: () => void,
  winnerLabel?: string,
): () => void {
  const bd = backdrop();
  const c = card();

  const copy: Record<MatchOutcome, { title: string; color: string }> = {
    win: {
      // `BREACH SUCCESSFUL — {TEAM/HANDLE} WINS`
      title: winnerLabel
        ? `BREACH SUCCESSFUL — ${winnerLabel} WINS`
        : "BREACH SUCCESSFUL",
      color: "var(--ready)",
    },
    loss: { title: "BREACH FAILED", color: "var(--danger)" },
    draw: { title: "STALEMATE — NO BREACH", color: "var(--muted)" },
  };

  const { title, color } = copy[outcome];
  const h = heading(title, color);
  const ret = primaryButton("RETURN TO LOBBY");

  const remove = (): void => bd.remove();
  ret.addEventListener("click", () => {
    remove();
    onReturn();
  });

  c.append(h, ret);
  bd.appendChild(c);
  document.body.appendChild(bd);
  return remove;
}
