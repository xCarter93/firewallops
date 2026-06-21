/**
 * hudOverlay.ts — the DOM render layer of the Phase-6 HUD.
 *
 * The ONE normalized public contract (review concern 6):
 *
 *     mountHudOverlay(container, opts?) → { update(vm, countdownText?), destroy() }
 *
 * The DOM is built ONCE in `mountHudOverlay` (the `.fw-hud` overlay root —
 * `inset:0; z-index:50; pointer-events:none` — with all six regions). `update`
 * DIFF-MUTATES text + inline-style in place: NO per-frame innerHTML, and the
 * turn-order rows + minimap blips are reconciled by id via `Map<id, HTMLElement>`.
 *
 * It consumes the PURE `HudViewModel` (plan 06-01) and is fully testable in jsdom
 * without Phaser or Colyseus — it imports ONLY the view-model TYPES.
 *
 * Render channels:
 *   - UI-02  active turn row + countdown line + YOU badge
 *   - UI-03  per-row HP number (immediate) + red pulse (channel 2), gated to the
 *            synced shot-resolution phase so the row pulse coincides with impact
 *            (review concern 5)
 *   - CF-1   a NON-NUMERIC `RECONNECTING…` row state — there is no synced
 *            disconnect deadline, so no fabricated 30s countdown (review concern 2)
 *   - SC-1   the LIVE action-bar mirror driven by `vm.actionBar` (review concern 1)
 *   - empty-states for every region
 *
 * SECURITY (T-06-05): every dynamic string (handles, winner labels, chat) is
 * written via `.textContent`, NEVER `innerHTML` with interpolated state. `innerHTML`
 * is used only for static literal markup with no interpolated state.
 *
 * INPUT (T-06-06): the root and the action-bar mirror stay `pointer-events:none`
 * so canvas drag / keyboard aim+fire input passes through to the Phaser canvas.
 */

import type {
  HudActionBar,
  HudBlip,
  HudTurnRow,
  HudViewModel,
  HudWeapon,
} from "./hudViewModel.js";

// ─────────────────────────── local DOM idiom ────────────────────────────────
// Reused from shell/pages/landing.ts (not exported there): the typed
// `createElement` + className helper. No framework — vanilla TS DOM, the
// established shell idiom.

/** Small typed `createElement` helper that sets a class name. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Typed createElementNS helper for the SVG decorations (arrow / silhouette / blips). */
function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

// ─────────────────────────── style constants ────────────────────────────────
// Token names are consumed via var(--token); never hardcode hex (UI-SPEC §Color).

const PANEL_BG = "rgba(20, 30, 51, 0.72)"; // var(--surface) at opacity, blur panel
const CYAN_GLOW = "0 0 12px rgba(34, 211, 238, 0.55)";
const PULSE_MS = 400;

/** The synced phase string the server reports while a shot resolves (concern 5). */
const RESOLUTION_PHASE = "RESOLVING";

/** Shared blur-panel chrome for the six HUD regions. */
function panelStyle(node: HTMLElement): void {
  Object.assign(node.style, {
    position: "absolute",
    background: PANEL_BG,
    backdropFilter: "blur(6px)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-5)",
    padding: "var(--space-sm) var(--space-md)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
}

// ─────────────────────────── return type ────────────────────────────────────

export interface HudOverlayHandle {
  /**
   * The ONE normalized public contract (concern 6). `countdownText` is the
   * pre-formatted "M:SS" string from the caller's rAF tick — OPTIONAL because the
   * VM does not store it. There is NO `update(vm)`-only overload.
   */
  update(vm: HudViewModel, countdownText?: string): void;
  /** Idempotent teardown — clears pulse timers, the reconcile Maps, and removes the root. */
  destroy(): void;
}

// ─────────────────────────── mount ──────────────────────────────────────────

/**
 * Build the full HUD overlay DOM ONCE and return the diff-mutating handle.
 * `opts.reloadControl` is a future hook to gate a single `pointer-events:auto`
 * reload button on the end-banner; it defaults to false (keyboard-reload v1,
 * preserving the pointer-events:none invariant — RESEARCH Open Question 2).
 */
export function mountHudOverlay(
  container: HTMLElement,
  opts?: { reloadControl?: boolean },
): HudOverlayHandle {
  const reloadControl = opts?.reloadControl === true;

  // ── root: inset:0, z-index:50, pointer-events:none (T-06-06) ──────────────
  const root = el("div", "fw-hud");
  Object.assign(root.style, {
    position: "absolute",
    inset: "0",
    zIndex: "50",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  container.appendChild(root);

  // ── reconcile state ───────────────────────────────────────────────────────
  const rowEls = new Map<string, HTMLElement>();
  const blipEls = new Map<string, HTMLElement>();
  const prevHp = new Map<string, number>();
  const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let destroyed = false;

  // ── region: turn order (top-left) — round badge + rows container ──────────
  const regionTurnOrder = el("div", "fw-hud-turnorder");
  panelStyle(regionTurnOrder);
  Object.assign(regionTurnOrder.style, {
    top: "var(--space-md)",
    left: "var(--space-md)",
    minWidth: "180px",
  } satisfies Partial<CSSStyleDeclaration>);
  const roundBadge = el("div", "fw-hud-round fw-label");
  roundBadge.textContent = "ROUND —";
  const rowsContainer = el("div", "fw-hud-rows");
  Object.assign(rowsContainer.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
    marginTop: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
  regionTurnOrder.append(roundBadge, rowsContainer);

  // ── region: wind + timer (top-center) — gauge + focal countdown line ──────
  const regionWindTimer = el("div", "fw-hud-windtimer");
  panelStyle(regionWindTimer);
  Object.assign(regionWindTimer.style, {
    top: "var(--space-md)",
    left: "50%",
    transform: "translateX(-50%)",
    textAlign: "center",
    minWidth: "160px",
  } satisfies Partial<CSSStyleDeclaration>);

  const windRow = el("div", "fw-hud-wind");
  Object.assign(windRow.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
  const windLabel = el("span", "fw-label");
  windLabel.textContent = "WIND";
  const windValue = el("span", "fw-hud-wind-val fw-num");
  Object.assign(windValue.style, { color: "var(--warn)" } satisfies Partial<CSSStyleDeclaration>);
  windValue.textContent = "0";
  // A vector arrow drawn via SVG (no emoji).
  const windArrowSvg = svg("svg");
  windArrowSvg.setAttribute("width", "20");
  windArrowSvg.setAttribute("height", "12");
  windArrowSvg.setAttribute("viewBox", "0 0 20 12");
  const windArrowLine = svg("path");
  windArrowLine.setAttribute("d", "M2 6 H14 M10 2 L14 6 L10 10");
  windArrowLine.setAttribute("fill", "none");
  windArrowLine.setAttribute("stroke", "var(--warn)");
  windArrowLine.setAttribute("stroke-width", "1.5");
  windArrowSvg.appendChild(windArrowLine);
  windRow.append(windLabel, windValue, windArrowSvg);

  const countdownLine = el("div", "fw-hud-countdown");
  Object.assign(countdownLine.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "18px",
    letterSpacing: "0.06em",
    marginTop: "var(--space-xs)",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  regionWindTimer.append(windRow, countdownLine);

  // ── region: minimap (top-right) — terrain silhouette + blips layer ────────
  const regionMinimap = el("div", "fw-hud-minimap");
  panelStyle(regionMinimap);
  Object.assign(regionMinimap.style, {
    top: "var(--space-md)",
    right: "var(--space-md)",
    width: "180px",
    height: "64px",
  } satisfies Partial<CSSStyleDeclaration>);
  const minimapSvg = svg("svg");
  minimapSvg.setAttribute("width", "100%");
  minimapSvg.setAttribute("height", "100%");
  minimapSvg.setAttribute("viewBox", "0 0 180 48");
  minimapSvg.setAttribute("preserveAspectRatio", "none");
  // Static terrain silhouette (Claude's discretion — a representative ridge line).
  const silhouette = svg("path");
  silhouette.setAttribute(
    "d",
    "M0 44 L20 30 L48 36 L80 18 L110 30 L140 22 L180 38 L180 48 L0 48 Z",
  );
  silhouette.setAttribute("fill", "var(--surface-2)");
  silhouette.setAttribute("stroke", "var(--line)");
  silhouette.setAttribute("stroke-width", "1");
  minimapSvg.appendChild(silhouette);
  const blipsLayer = el("div", "fw-hud-blips");
  Object.assign(blipsLayer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  regionMinimap.append(minimapSvg, blipsLayer);

  // ── region: chat (bottom-left) — empty-state only ─────────────────────────
  const regionChat = el("div", "fw-hud-chat");
  panelStyle(regionChat);
  Object.assign(regionChat.style, {
    bottom: "120px",
    left: "var(--space-md)",
    width: "240px",
  } satisfies Partial<CSSStyleDeclaration>);
  const chatHeading = el("div", "fw-hud-chat-heading fw-label");
  chatHeading.textContent = "COMMS CHANNEL OFFLINE";
  Object.assign(chatHeading.style, { color: "var(--muted)" } satisfies Partial<CSSStyleDeclaration>);
  const chatComposer = el("input", "fw-hud-chat-composer");
  chatComposer.type = "text";
  chatComposer.disabled = true;
  // The disabled-composer placeholder copy lives in the UI-SPEC; set it via the
  // property (faint, never an interactive control in v1).
  chatComposer.placeholder = "— channel offline —";
  Object.assign(chatComposer.style, {
    marginTop: "var(--space-sm)",
    width: "100%",
    background: "transparent",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-3)",
    padding: "var(--space-xs) var(--space-sm)",
    color: "var(--faint)",
    fontFamily: "var(--font-body)",
    fontSize: "11px",
  } satisfies Partial<CSSStyleDeclaration>);
  regionChat.append(chatHeading, chatComposer);

  // ── region: action bar (bottom) — LIVE DISPLAY MIRROR (concern 1) ─────────
  const regionActionBar = el("div", "fw-hud-actionbar");
  panelStyle(regionActionBar);
  Object.assign(regionActionBar.style, {
    bottom: "var(--space-md)",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-md)",
    pointerEvents: "none", // it is a mirror — no click handlers in v1
  } satisfies Partial<CSSStyleDeclaration>);

  // Three weapon chips, cached by chip id.
  const chipEls = new Map<string, HTMLElement>();
  const chipLabelDefs: ReadonlyArray<{ id: string; label: string }> = [
    { id: "packet", label: "PACKET" },
    { id: "forked", label: "FORKED" },
    { id: "trojan", label: "TROJAN" },
  ];
  const chipsWrap = el("div", "fw-hud-chips");
  Object.assign(chipsWrap.style, {
    display: "flex",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
  // The trojan lock/charge indicator (cached separately).
  let trojanIndicator: HTMLElement | null = null;
  for (const def of chipLabelDefs) {
    const chip = el("div", "fw-hud-chip");
    Object.assign(chip.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px",
      padding: "var(--space-xs) var(--space-sm)",
      border: "1px solid var(--line)",
      borderRadius: "var(--radius-3)",
      fontFamily: "var(--font-display)",
      fontSize: "11px",
      letterSpacing: "0.06em",
      color: "var(--muted)",
    } satisfies Partial<CSSStyleDeclaration>);
    const chipLabel = el("span", "fw-hud-chip-label");
    chipLabel.textContent = def.label;
    chip.appendChild(chipLabel);
    if (def.id === "trojan") {
      const ind = el("span", "fw-hud-trojan-charge fw-num");
      ind.textContent = "0/3";
      Object.assign(ind.style, { fontSize: "10px", color: "var(--faint)" } satisfies Partial<CSSStyleDeclaration>);
      chip.appendChild(ind);
      trojanIndicator = ind;
    }
    chipEls.set(def.id, chip);
    chipsWrap.appendChild(chip);
  }

  // MOVE budget element.
  const moveWrap = el("div", "fw-hud-move");
  Object.assign(moveWrap.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  const moveLabel = el("span", "fw-label");
  moveLabel.textContent = "MOVE";
  const moveValue = el("span", "fw-hud-move-val fw-num");
  moveValue.textContent = "—";
  moveWrap.append(moveLabel, moveValue);

  // Power meter + % readout.
  const powerWrap = el("div", "fw-hud-power");
  Object.assign(powerWrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "120px",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerHeader = el("div", "fw-hud-power-header");
  Object.assign(powerHeader.style, {
    display: "flex",
    justifyContent: "space-between",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerLabel = el("span", "fw-label");
  powerLabel.textContent = "POWER";
  const powerPct = el("span", "fw-hud-power-pct fw-num");
  powerPct.textContent = "0%";
  Object.assign(powerPct.style, { color: "var(--accent)" } satisfies Partial<CSSStyleDeclaration>);
  powerHeader.append(powerLabel, powerPct);
  const powerTrack = el("div", "fw-hud-power-track");
  Object.assign(powerTrack.style, {
    height: "6px",
    background: "var(--surface-2)",
    borderRadius: "var(--radius-2)",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerFill = el("div", "fw-hud-power-fill");
  Object.assign(powerFill.style, {
    height: "100%",
    width: "0%",
    background: "var(--accent)",
  } satisfies Partial<CSSStyleDeclaration>);
  powerTrack.appendChild(powerFill);
  powerWrap.append(powerHeader, powerTrack);

  // FIRE button face (display-only, clip-path corner). Static markup only.
  const fireFace = el("div", "fw-hud-fire");
  fireFace.textContent = "FIRE";
  Object.assign(fireFace.style, {
    padding: "var(--space-sm) var(--space-lg)",
    background: "var(--accent)",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "13px",
    letterSpacing: "0.08em",
    borderRadius: "var(--radius-3)",
    clipPath: "polygon(0 0, 100% 0, 100% 70%, 88% 100%, 0 100%)",
  } satisfies Partial<CSSStyleDeclaration>);

  regionActionBar.append(chipsWrap, moveWrap, powerWrap, fireFace);

  // ── end-banner (center, hidden initially) ─────────────────────────────────
  const endBanner = el("div", "fw-hud-endbanner");
  panelStyle(endBanner);
  Object.assign(endBanner.style, {
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
    padding: "var(--space-xl) var(--space-2xl)",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const endWinner = el("div", "fw-hud-endbanner-winner");
  Object.assign(endWinner.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "900",
    fontSize: "22px",
    color: "var(--accent)",
    textShadow: CYAN_GLOW,
  } satisfies Partial<CSSStyleDeclaration>);
  const endSub = el("div", "fw-hud-endbanner-sub fw-label");
  endSub.textContent = "RELOAD TO REDEPLOY";
  Object.assign(endSub.style, { marginTop: "var(--space-sm)" } satisfies Partial<CSSStyleDeclaration>);
  endBanner.append(endWinner, endSub);
  if (reloadControl) {
    // Optional future hook: the ONLY allowed pointer-events:auto control, gated off
    // by default to preserve the pointer-events:none invariant.
    const reloadBtn = el("button", "fw-hud-reload fw-btn-primary");
    reloadBtn.textContent = "REDEPLOY";
    Object.assign(reloadBtn.style, {
      marginTop: "var(--space-md)",
      pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    reloadBtn.addEventListener("click", () => window.location.reload());
    endBanner.appendChild(reloadBtn);
  }

  root.append(
    regionTurnOrder,
    regionWindTimer,
    regionMinimap,
    regionChat,
    regionActionBar,
    endBanner,
  );

  // ─────────────────────────── row build/mutate ──────────────────────────────

  interface RowRefs {
    root: HTMLElement;
    marker: HTMLElement;
    label: HTMLElement;
    youBadge: HTMLElement;
    reconnTag: HTMLElement;
    hp: HTMLElement;
  }
  const rowRefs = new Map<string, RowRefs>();

  function buildRow(): RowRefs {
    const rowRoot = el("div", "fw-hud-row");
    Object.assign(rowRoot.style, {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-xs)",
      padding: "2px var(--space-xs)",
      border: "1px solid transparent",
      borderRadius: "var(--radius-2)",
      fontFamily: "var(--font-body)",
      fontSize: "12px",
      color: "var(--text-2)",
      transition: "background 120ms, color 120ms",
    } satisfies Partial<CSSStyleDeclaration>);
    const marker = el("span", "fw-hud-row-marker");
    marker.textContent = ""; // ▸ when active
    Object.assign(marker.style, { width: "10px", color: "var(--accent)" } satisfies Partial<CSSStyleDeclaration>);
    const label = el("span", "fw-hud-row-label");
    const youBadge = el("span", "fw-hud-row-you");
    youBadge.textContent = "YOU";
    Object.assign(youBadge.style, {
      display: "none",
      padding: "0 4px",
      background: "var(--accent)",
      color: "var(--bg-deeper)",
      borderRadius: "var(--radius-2)",
      fontSize: "9px",
      fontWeight: "700",
    } satisfies Partial<CSSStyleDeclaration>);
    const reconnTag = el("span", "fw-hud-row-reconnecting");
    reconnTag.textContent = "RECONNECTING…";
    Object.assign(reconnTag.style, {
      display: "none",
      color: "var(--warn)",
      fontSize: "10px",
      letterSpacing: "0.04em",
    } satisfies Partial<CSSStyleDeclaration>);
    const hp = el("span", "fw-hud-row-hp fw-num");
    Object.assign(hp.style, { marginLeft: "auto", color: "var(--text)" } satisfies Partial<CSSStyleDeclaration>);
    rowRoot.append(marker, label, youBadge, reconnTag, hp);
    return { root: rowRoot, marker, label, youBadge, reconnTag, hp };
  }

  function applyRow(row: HudTurnRow, refs: RowRefs): void {
    // Identity (concern 7): label via textContent (XSS guard); YOU badge gated.
    refs.label.textContent = row.label;
    refs.youBadge.style.display = row.isLocal ? "inline-block" : "none";

    // Active styling — cyan border + ▸ marker.
    refs.marker.textContent = row.isActive ? "▸" : "";
    refs.root.style.borderColor = row.isActive ? "var(--accent)" : "transparent";

    // Eliminated styling — strike-through + OUT.
    if (row.eliminated) {
      refs.root.style.textDecoration = "line-through";
      refs.root.style.opacity = "0.55";
      refs.hp.textContent = "OUT";
    } else {
      refs.root.style.textDecoration = "none";
      refs.root.style.opacity = "1";
      // HP NUMBER updates IMMEDIATELY on change (concern 5 — the number is not
      // the impact-aligned signal; the pulse is).
      refs.hp.textContent = String(row.hp);
    }

    // CF-1 (concern 2) — NON-NUMERIC RECONNECTING… state, no fabricated deadline.
    refs.reconnTag.style.display = row.connected ? "none" : "inline-block";

    // UI-03 channel 2 — red pulse gated on hp-decrease AND the resolution phase.
    // (Mutation of prevHp + the pulse is driven from update() so it sees vm.phase.)
  }

  // ─────────────────────────── blip build/mutate ─────────────────────────────

  function buildBlip(): HTMLElement {
    const b = el("div", "fw-hud-blip");
    Object.assign(b.style, {
      position: "absolute",
      bottom: "8px",
      width: "8px",
      height: "8px",
      marginLeft: "-4px",
      borderRadius: "50%",
      background: "var(--muted)",
    } satisfies Partial<CSSStyleDeclaration>);
    return b;
  }

  // ─────────────────────────── pulse helper ──────────────────────────────────

  function pulseRow(id: string, refs: RowRefs): void {
    refs.root.classList.add("fw-hud-row--hit");
    refs.root.style.background = "var(--danger)";
    refs.root.style.color = "var(--text)";
    const existing = pulseTimers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      if (destroyed) return;
      refs.root.classList.remove("fw-hud-row--hit");
      refs.root.style.background = "";
      refs.root.style.color = "var(--text-2)";
      pulseTimers.delete(id);
    }, PULSE_MS);
    pulseTimers.set(id, t);
  }

  // ─────────────────────────── action-bar mutate ─────────────────────────────

  function applyActionBar(ab: HudActionBar): void {
    const byId = new Map<string, HudWeapon>();
    for (const w of ab.weapons) byId.set(w.id, w);

    for (const [id, chip] of chipEls) {
      const w = byId.get(id);
      const selected = w?.selected === true && ab.hasLocalMobile;
      chip.style.borderColor = selected ? "var(--accent)" : "var(--line)";
      chip.style.color = selected ? "var(--accent)" : "var(--muted)";
      chip.style.boxShadow = selected ? CYAN_GLOW : "none";
      if (id === "trojan" && trojanIndicator) {
        const locked = w?.locked === true && ab.hasLocalMobile;
        // chargeLabel is e.g. "2/3"; lock glyph pairs with it (never color-only).
        const charge = w?.chargeLabel ?? "0/3";
        trojanIndicator.textContent = locked ? `⊠ ${charge}` : charge;
        trojanIndicator.style.color = locked ? "var(--warn)" : "var(--faint)";
      }
    }

    // Power meter: map ab.power (the server power 0..100 wire value) to a width %.
    // Documented scale: power is treated as a 0..100 percentage; clamped to [0,100].
    const pct = ab.hasLocalMobile ? Math.max(0, Math.min(100, Math.round(ab.power))) : 0;
    powerFill.style.width = `${pct}%`;
    powerPct.textContent = `${pct}%`;

    // MOVE: the -1 sentinel renders a dash (moveBudget is NOT synced — concern 1).
    moveValue.textContent = ab.moveBudget < 0 ? "—" : String(ab.moveBudget);
  }

  // ─────────────────────────── update (diff-mutate) ──────────────────────────

  function update(vm: HudViewModel, countdownText?: string): void {
    if (destroyed) return;

    // Round badge — sentinel -1 → em-dash.
    roundBadge.textContent = vm.round < 0 ? "ROUND —" : `ROUND ${vm.round}`;

    // Wind value.
    windValue.textContent = String(Math.round(vm.wind));

    // Countdown / active line (UI-02). The VM does not store countdownText — it is
    // the caller's pre-formatted rAF string (concern 6).
    const active = vm.activeLabel + (countdownText ? ` ${countdownText}` : "");
    countdownLine.textContent = active;
    if (vm.activeIsLocal) {
      countdownLine.style.color = "var(--accent)";
      countdownLine.style.textShadow = CYAN_GLOW;
    } else {
      countdownLine.style.color = "var(--text)";
      countdownLine.style.textShadow = "none";
    }

    // ── Turn rows: reconcile by id, reorder, mutate ──────────────────────────
    const seen = new Set<string>();
    for (const row of vm.turnRows) {
      seen.add(row.id);
      let refs = rowRefs.get(row.id);
      if (!refs) {
        refs = buildRow();
        rowRefs.set(row.id, refs);
        rowEls.set(row.id, refs.root);
      }
      applyRow(row, refs);

      // UI-03 channel 2 — pulse gated on hp DECREASE AND the resolution phase.
      const prior = prevHp.get(row.id);
      if (
        prior !== undefined &&
        row.hp < prior &&
        vm.phase === RESOLUTION_PHASE
      ) {
        pulseRow(row.id, refs);
      }
      prevHp.set(row.id, row.hp);
    }
    // Remove stale rows.
    for (const [id, node] of rowEls) {
      if (!seen.has(id)) {
        const t = pulseTimers.get(id);
        if (t) {
          clearTimeout(t);
          pulseTimers.delete(id);
        }
        node.remove();
        rowEls.delete(id);
        rowRefs.delete(id);
        prevHp.delete(id);
      }
    }
    // Reorder DOM to match vm.turnRows order (append in order — appendChild moves).
    for (const row of vm.turnRows) {
      const node = rowEls.get(row.id);
      if (node) rowsContainer.appendChild(node);
    }

    // ── Minimap blips: reconcile by id ───────────────────────────────────────
    const blipSeen = new Set<string>();
    for (const blip of vm.blips) {
      blipSeen.add(blip.id);
      let node = blipEls.get(blip.id);
      if (!node) {
        node = buildBlip();
        blipEls.set(blip.id, node);
        blipsLayer.appendChild(node);
      }
      applyBlip(blip, node);
    }
    for (const [id, node] of blipEls) {
      if (!blipSeen.has(id)) {
        node.remove();
        blipEls.delete(id);
      }
    }

    // ── Action bar (live mirror) ─────────────────────────────────────────────
    applyActionBar(vm.actionBar);

    // ── End banner ───────────────────────────────────────────────────────────
    if (vm.matchOver) {
      endBanner.style.display = "block";
      endWinner.textContent = winnerText(vm.winnerTeam);
    } else {
      endBanner.style.display = "none";
    }
  }

  function applyBlip(blip: HudBlip, node: HTMLElement): void {
    node.style.left = `${blip.xFrac * 100}%`;
    node.style.background = blip.isActive ? "var(--accent)" : "var(--muted)";
    node.style.boxShadow = blip.isActive ? CYAN_GLOW : "none";
  }

  // ─────────────────────────── destroy (idempotent) ──────────────────────────

  function destroy(): void {
    if (destroyed) {
      // Idempotent — safe to call twice (plan 04 calls it on reconnect remount).
      root.remove();
      return;
    }
    destroyed = true;
    for (const t of pulseTimers.values()) clearTimeout(t);
    pulseTimers.clear();
    rowEls.clear();
    rowRefs.clear();
    blipEls.clear();
    prevHp.clear();
    root.remove();
  }

  return { update, destroy };
}

/** UI-SPEC end-banner copy — display-only, mapped from the synced winnerTeam. */
function winnerText(winnerTeam: number): string {
  if (winnerTeam === 0) return "BREACH SUCCESSFUL — TEAM A WINS";
  if (winnerTeam === 1) return "BREACH SUCCESSFUL — TEAM B WINS";
  if (winnerTeam < 0) return "STALEMATE — NO BREACH";
  return `BREACH SUCCESSFUL — TEAM ${winnerTeam} WINS`;
}
