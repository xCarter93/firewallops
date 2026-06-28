/**
 * hudOverlay.ts — the DOM render layer of the Phase-6 HUD.
 *
 * VISUAL: re-skinned to the founder's Meshed "In-Game HUD" (SCREEN 4 of
 * 06-MESHED-DESIGN.dc.html) — chamfered slate panels with glowing cyan/violet
 * edge-bars, angled-tab weapon chips, a `//` circuit-rail header band, and the
 * Orbitron / Saira Condensed / Share Tech Mono type stack. It consumes the shared
 * foundation `shell/meshed.ts` (chamfer/angledTab/edgeBar/circuitRail/MESH/FONT)
 * and the shell.css tokens; it does NOT modify those foundation files.
 *
 * The `.fw-hud` root remains a TRANSPARENT pass-through layer over the live Phaser
 * canvas (`position:absolute; inset:0; pointer-events:none; z-index:50`) — only the
 * individual region panels get Meshed chrome; the root never paints an opaque field.
 *
 * The ONE normalized public contract (review concern 6):
 *
 *     mountHudOverlay(container, opts?) → { update(vm, countdownText?), destroy() }
 *
 * The DOM is built ONCE in `mountHudOverlay`. `update` DIFF-MUTATES text +
 * inline-style in place: NO per-frame innerHTML, and the turn-order rows + minimap
 * blips are reconciled by id via `Map<id, HTMLElement>`.
 *
 * It consumes the PURE `HudViewModel` (plan 06-01) and is fully testable in jsdom
 * without Phaser or Colyseus — it imports ONLY the view-model TYPES + the pure
 * Meshed foundation helpers.
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
 * / `insertAdjacentHTML` is used only for the STATIC Meshed chrome from `meshed.ts`
 * (edgeBar/circuitRail emit no caller input).
 *
 * INPUT (T-06-06): the root and the action-bar mirror stay `pointer-events:none`
 * so canvas drag / keyboard aim+fire input passes through to the Phaser canvas.
 */

import { FONT, angledTab, chamfer, edgeBar } from "../meshed.js";
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
// Token names are consumed via var(--token); never hardcode hex in the panels.
// The Meshed chrome motifs (chamfer/edgeBar/angledTab) come from the foundation.

/** Meshed slate panel field — translucent #08101a over the live canvas. */
const PANEL_BG = "rgba(8, 16, 26, 0.85)";
/** A subtle lit Meshed hairline border to match the chamfer cut-edge. */
const PANEL_BORDER = "1px solid rgba(95, 200, 245, 0.18)";
/** Brighter hairline for the active/focal panels (countdown, active nameplate). */
const PANEL_BORDER_HOT = "1px solid rgba(95, 200, 245, 0.4)";
const CYAN_GLOW = "0 0 16px rgba(95, 200, 245, 0.6)";
const PULSE_MS = 400;

/** The synced phase string the server reports while a shot resolves (concern 5). */
const RESOLUTION_PHASE = "RESOLVING";

/**
 * Shared Meshed chamfered-panel chrome for the HUD regions. The panel is a
 * translucent slate field with a lit cyan hairline and an 8-point chamfered
 * clip-path (foundation `chamfer()`). `relative` so an `edgeBar()` (absolute,
 * left:0) can be inserted as a positioned child.
 */
function panelStyle(node: HTMLElement, cut = 12): void {
  Object.assign(node.style, {
    position: "absolute",
    background: PANEL_BG,
    backdropFilter: "blur(4px)",
    border: PANEL_BORDER,
    clipPath: chamfer(cut),
    padding: "var(--space-sm) var(--space-md)",
    pointerEvents: "none",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
}

/** A Meshed `//` circuit-rail header band (label + mono meta), static markup. */
function headerBand(label: string, meta: string): HTMLElement {
  const band = el("div", "fw-hud-band");
  Object.assign(band.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: "var(--space-sm)",
    marginBottom: "var(--space-sm)",
    borderBottom: "1px solid rgba(95, 200, 245, 0.12)",
  } satisfies Partial<CSSStyleDeclaration>);
  const labelEl = el("span", "fw-hud-band-label");
  labelEl.textContent = label; // static literal copy
  Object.assign(labelEl.style, {
    fontFamily: FONT.alt,
    fontSize: "10px",
    letterSpacing: "0.12em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const metaEl = el("span", "fw-hud-band-meta fw-num");
  metaEl.textContent = meta; // static literal `//`-style mono tag
  Object.assign(metaEl.style, {
    fontFamily: FONT.mono,
    fontSize: "9px",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  band.append(labelEl, metaEl);
  return band;
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
  // Transparent pass-through — NO opaque field; only the regions get chrome.
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

  // ── region: turn order (top-left) — chamfered panel + edge-bar + queue band ─
  const regionTurnOrder = el("div", "fw-hud-turnorder");
  panelStyle(regionTurnOrder);
  Object.assign(regionTurnOrder.style, {
    top: "var(--space-md)",
    left: "var(--space-md)",
    width: "218px",
    padding: "0", // band + rows manage their own padding
  } satisfies Partial<CSSStyleDeclaration>);
  // Glowing left edge-bar (foundation; static markup, no interpolated state).
  regionTurnOrder.insertAdjacentHTML("afterbegin", edgeBar(3));
  const turnOrderBody = el("div", "fw-hud-turnorder-body");
  Object.assign(turnOrderBody.style, {
    padding: "var(--space-sm) var(--space-md)",
  } satisfies Partial<CSSStyleDeclaration>);
  const turnHeader = headerBand("TURN QUEUE", "//");
  const roundBadge = el("span", "fw-hud-round fw-num");
  roundBadge.textContent = "RND —";
  Object.assign(roundBadge.style, {
    fontFamily: FONT.mono,
    fontSize: "9px",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  // Replace the header's static meta with the live round badge node.
  turnHeader.querySelector(".fw-hud-band-meta")?.replaceWith(roundBadge);
  const rowsContainer = el("div", "fw-hud-rows");
  Object.assign(rowsContainer.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
  } satisfies Partial<CSSStyleDeclaration>);
  turnOrderBody.append(turnHeader, rowsContainer);
  regionTurnOrder.append(turnOrderBody);

  // ── region: wind + timer (top-center) — twin chamfered tiles ──────────────
  const regionWindTimer = el("div", "fw-hud-windtimer");
  Object.assign(regionWindTimer.style, {
    position: "absolute",
    top: "var(--space-md)",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "stretch",
    gap: "var(--space-md)",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  // Wind tile.
  const windTile = el("div", "fw-hud-wind");
  Object.assign(windTile.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--space-xs)",
    background: PANEL_BG,
    border: PANEL_BORDER,
    clipPath: chamfer(10),
    backdropFilter: "blur(4px)",
    padding: "var(--space-sm) var(--space-lg)",
  } satisfies Partial<CSSStyleDeclaration>);
  const windLabel = el("span", "fw-hud-wind-label");
  windLabel.textContent = "PACKET-WIND";
  Object.assign(windLabel.style, {
    fontFamily: FONT.alt,
    fontSize: "9px",
    letterSpacing: "0.14em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const windInner = el("div", "fw-hud-wind-inner");
  Object.assign(windInner.style, {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
  // A vector arrow drawn via SVG (no emoji).
  const windArrowSvg = svg("svg");
  windArrowSvg.setAttribute("width", "44");
  windArrowSvg.setAttribute("height", "16");
  windArrowSvg.setAttribute("viewBox", "0 0 44 16");
  const windArrowLine = svg("path");
  windArrowLine.setAttribute("d", "M4 8 H34 M28 3 L36 8 L28 13");
  windArrowLine.setAttribute("fill", "none");
  windArrowLine.setAttribute("stroke", "var(--text)");
  windArrowLine.setAttribute("stroke-width", "2");
  windArrowSvg.appendChild(windArrowLine);
  const windValue = el("span", "fw-hud-wind-val fw-num");
  Object.assign(windValue.style, {
    fontFamily: FONT.mono,
    fontSize: "18px",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  windValue.textContent = "0";
  windInner.append(windArrowSvg, windValue);
  windTile.append(windLabel, windInner);

  // Timer tile (focal — hotter hairline + glow).
  const timerTile = el("div", "fw-hud-timer");
  Object.assign(timerTile.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--space-xs)",
    background: PANEL_BG,
    border: PANEL_BORDER_HOT,
    clipPath: chamfer(10),
    backdropFilter: "blur(4px)",
    padding: "var(--space-sm) var(--space-lg)",
    minWidth: "120px",
  } satisfies Partial<CSSStyleDeclaration>);
  const timerLabel = el("span", "fw-hud-timer-label");
  timerLabel.textContent = "TURN TIMER";
  Object.assign(timerLabel.style, {
    fontFamily: FONT.alt,
    fontSize: "9px",
    letterSpacing: "0.14em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const countdownLine = el("div", "fw-hud-countdown");
  Object.assign(countdownLine.style, {
    fontFamily: FONT.display,
    fontWeight: "800",
    fontSize: "20px",
    letterSpacing: "0.04em",
    color: "var(--glow)",
    textShadow: CYAN_GLOW,
  } satisfies Partial<CSSStyleDeclaration>);
  timerTile.append(timerLabel, countdownLine);

  regionWindTimer.append(windTile, timerTile);

  // ── region: minimap (top-right) — chamfered panel + tactical band + blips ──
  const regionMinimap = el("div", "fw-hud-minimap");
  panelStyle(regionMinimap);
  Object.assign(regionMinimap.style, {
    top: "var(--space-md)",
    right: "var(--space-md)",
    width: "236px",
    padding: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  regionMinimap.insertAdjacentHTML("afterbegin", edgeBar(3));
  const minimapBody = el("div", "fw-hud-minimap-body");
  Object.assign(minimapBody.style, {
    padding: "var(--space-sm) var(--space-md) 0",
  } satisfies Partial<CSSStyleDeclaration>);
  const minimapHeader = headerBand("TACTICAL MAP", "0x1f");
  // Remove the band's bottom margin — the map plate sits flush under it.
  minimapHeader.style.marginBottom = "0";
  const minimapPlate = el("div", "fw-hud-minimap-plate");
  Object.assign(minimapPlate.style, {
    position: "relative",
    height: "96px",
    background: "linear-gradient(180deg, #08111f, #0c1830)",
    backgroundImage:
      "linear-gradient(rgba(95,200,245,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(95,200,245,0.05) 1px, transparent 1px)",
    backgroundSize: "20px 20px",
  } satisfies Partial<CSSStyleDeclaration>);
  const minimapSvg = svg("svg");
  minimapSvg.setAttribute("width", "100%");
  minimapSvg.setAttribute("height", "100%");
  minimapSvg.setAttribute("viewBox", "0 0 236 96");
  minimapSvg.setAttribute("preserveAspectRatio", "none");
  // Static terrain silhouette — the Meshed ridge line.
  const silhouette = svg("path");
  silhouette.setAttribute(
    "d",
    "M0 72 L42 66 L78 76 L112 56 L154 70 L194 58 L236 66 L236 96 L0 96 Z",
  );
  silhouette.setAttribute("fill", "rgba(95,200,245,0.1)");
  silhouette.setAttribute("stroke", "rgba(95,200,245,0.28)");
  silhouette.setAttribute("stroke-width", "1");
  minimapSvg.appendChild(silhouette);
  const blipsLayer = el("div", "fw-hud-blips");
  Object.assign(blipsLayer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  minimapPlate.append(minimapSvg, blipsLayer);
  minimapBody.append(minimapHeader, minimapPlate);
  regionMinimap.append(minimapBody);

  // ── region: chat (bottom-left) — terminal empty-state ─────────────────────
  const regionChat = el("div", "fw-hud-chat");
  panelStyle(regionChat, 10);
  Object.assign(regionChat.style, {
    bottom: "152px",
    left: "var(--space-md)",
    width: "320px",
  } satisfies Partial<CSSStyleDeclaration>);
  regionChat.insertAdjacentHTML("afterbegin", edgeBar(3));
  const chatHeading = el("div", "fw-hud-chat-heading");
  chatHeading.textContent = "COMMS CHANNEL OFFLINE";
  Object.assign(chatHeading.style, {
    fontFamily: FONT.mono,
    fontSize: "11px",
    letterSpacing: "0.06em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const chatComposer = el("input", "fw-hud-chat-composer");
  chatComposer.type = "text";
  chatComposer.disabled = true;
  // The disabled-composer placeholder copy lives in the UI-SPEC; set it via the
  // property (faint, never an interactive control in v1).
  chatComposer.placeholder = "> channel offline —";
  Object.assign(chatComposer.style, {
    marginTop: "var(--space-sm)",
    width: "100%",
    background: "rgba(8, 16, 26, 0.6)",
    border: PANEL_BORDER,
    clipPath: angledTab(4),
    padding: "var(--space-xs) var(--space-sm)",
    color: "var(--faint)",
    fontFamily: FONT.mono,
    fontSize: "11px",
  } satisfies Partial<CSSStyleDeclaration>);
  regionChat.append(chatHeading, chatComposer);

  // ── region: action bar (bottom) — LIVE DISPLAY MIRROR (concern 1) ─────────
  const regionActionBar = el("div", "fw-hud-actionbar");
  Object.assign(regionActionBar.style, {
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: "var(--space-md)",
    padding: "0 var(--space-lg) var(--space-md)",
    // Gradient lift from the bottom of the screen (matches the Meshed mockup).
    background: "linear-gradient(180deg, transparent, rgba(8,16,26,0.96) 40%)",
    pointerEvents: "none", // it is a mirror — no click handlers in v1
  } satisfies Partial<CSSStyleDeclaration>);

  // Three weapon chips (angled-tab Meshed faces), cached by chip id.
  const chipEls = new Map<string, HTMLElement>();
  const chipLabelDefs: ReadonlyArray<{ id: string; label: string; slot: string }> = [
    { id: "packet", label: "PACKET", slot: "s1" },
    { id: "forked", label: "FORKED", slot: "s2" },
    { id: "trojan", label: "TROJAN", slot: "s3" },
  ];
  const chipsCol = el("div", "fw-hud-chips-col");
  Object.assign(chipsCol.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
  } satisfies Partial<CSSStyleDeclaration>);
  const chipsHead = el("span", "fw-hud-chips-head");
  chipsHead.textContent = "WEAPON";
  Object.assign(chipsHead.style, {
    fontFamily: FONT.alt,
    fontSize: "9px",
    letterSpacing: "0.12em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
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
      justifyContent: "center",
      gap: "var(--space-xs)",
      width: "76px",
      height: "76px",
      background: "rgba(17, 28, 48, 0.8)",
      border: PANEL_BORDER,
      clipPath: chamfer(10),
      fontFamily: FONT.mono,
      fontSize: "9px",
      letterSpacing: "0.06em",
      color: "var(--muted)",
    } satisfies Partial<CSSStyleDeclaration>);
    const chipLabel = el("span", "fw-hud-chip-label");
    chipLabel.textContent = def.label;
    const chipSlot = el("span", "fw-hud-chip-slot");
    chipSlot.textContent = def.slot;
    Object.assign(chipSlot.style, {
      fontSize: "8px",
      color: "var(--faint)",
    } satisfies Partial<CSSStyleDeclaration>);
    chip.append(chipLabel, chipSlot);
    if (def.id === "trojan") {
      const ind = el("span", "fw-hud-trojan-charge fw-num");
      ind.textContent = "0/3";
      Object.assign(ind.style, {
        fontSize: "9px",
        color: "var(--faint)",
      } satisfies Partial<CSSStyleDeclaration>);
      chip.appendChild(ind);
      trojanIndicator = ind;
    }
    chipEls.set(def.id, chip);
    chipsWrap.appendChild(chip);
  }
  chipsCol.append(chipsHead, chipsWrap);

  // MOVE budget element (chamfered tile).
  const moveWrap = el("div", "fw-hud-move");
  Object.assign(moveWrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
  } satisfies Partial<CSSStyleDeclaration>);
  const moveLabel = el("span", "fw-hud-move-head");
  moveLabel.textContent = "MOVE";
  Object.assign(moveLabel.style, {
    fontFamily: FONT.alt,
    fontSize: "9px",
    letterSpacing: "0.12em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const moveTile = el("div", "fw-hud-move-tile");
  Object.assign(moveTile.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "92px",
    height: "76px",
    background: "rgba(17, 28, 48, 0.8)",
    border: PANEL_BORDER,
    clipPath: chamfer(10),
  } satisfies Partial<CSSStyleDeclaration>);
  const moveValue = el("span", "fw-hud-move-val fw-num");
  moveValue.textContent = "—";
  Object.assign(moveValue.style, {
    fontFamily: FONT.mono,
    fontSize: "22px",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  const moveHint = el("span", "fw-hud-move-hint");
  moveHint.textContent = "◂ A / D ▸";
  Object.assign(moveHint.style, {
    fontFamily: FONT.mono,
    fontSize: "8px",
    color: "var(--faint)",
    marginTop: "var(--space-xs)",
  } satisfies Partial<CSSStyleDeclaration>);
  moveTile.append(moveValue, moveHint);
  moveWrap.append(moveLabel, moveTile);

  // Power meter + % readout (chamfered tile, segmented fill).
  const powerWrap = el("div", "fw-hud-power");
  Object.assign(powerWrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
    flex: "1",
    maxWidth: "420px",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerHeader = el("div", "fw-hud-power-header");
  Object.assign(powerHeader.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerLabel = el("span", "fw-hud-power-label");
  powerLabel.textContent = "POWER";
  Object.assign(powerLabel.style, {
    fontFamily: FONT.alt,
    fontSize: "9px",
    letterSpacing: "0.12em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerPct = el("span", "fw-hud-power-pct fw-num");
  powerPct.textContent = "0%";
  Object.assign(powerPct.style, {
    fontFamily: FONT.mono,
    fontSize: "11px",
    color: "var(--glow)",
  } satisfies Partial<CSSStyleDeclaration>);
  powerHeader.append(powerLabel, powerPct);
  const powerTile = el("div", "fw-hud-power-tile");
  Object.assign(powerTile.style, {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    height: "76px",
    padding: "0 var(--space-md)",
    background: "rgba(17, 28, 48, 0.8)",
    border: PANEL_BORDER,
    clipPath: chamfer(10),
  } satisfies Partial<CSSStyleDeclaration>);
  const powerTrack = el("div", "fw-hud-power-track");
  Object.assign(powerTrack.style, {
    position: "relative",
    height: "16px",
    background: "#08111f",
    clipPath: angledTab(3),
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  const powerFill = el("div", "fw-hud-power-fill");
  Object.assign(powerFill.style, {
    position: "absolute",
    left: "0",
    top: "0",
    bottom: "0",
    width: "0%",
    background: "linear-gradient(90deg, #22C55E, #5fc8f5 70%, #F59E0B)",
    boxShadow: "0 0 14px rgba(95,200,245,0.5)",
  } satisfies Partial<CSSStyleDeclaration>);
  // Segmented tick overlay (static chrome).
  const powerTicks = el("div", "fw-hud-power-ticks");
  Object.assign(powerTicks.style, {
    position: "absolute",
    inset: "0",
    backgroundImage:
      "linear-gradient(90deg, rgba(8,17,31,0.7) 1px, transparent 1px)",
    backgroundSize: "5% 100%",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  powerTrack.append(powerFill, powerTicks);
  powerTile.append(powerTrack);
  powerWrap.append(powerHeader, powerTile);

  // FIRE button face (display-only, Meshed cut corner). Static markup only.
  const fireWrap = el("div", "fw-hud-fire-wrap");
  Object.assign(fireWrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-xs)",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  const fireHint = el("span", "fw-hud-fire-hint");
  fireHint.textContent = "SPACE ⎵";
  Object.assign(fireHint.style, {
    fontFamily: FONT.mono,
    fontSize: "9px",
    letterSpacing: "0.1em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  const fireFace = el("div", "fw-hud-fire");
  Object.assign(fireFace.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    width: "120px",
    height: "76px",
    background: "linear-gradient(160deg, #5fc8f5, #0891b2)",
    color: "var(--bg-deeper)",
    clipPath: "polygon(0 0, 100% 0, 100% 100%, 14px 100%, 0 calc(100% - 14px))",
    boxShadow: "0 0 28px -6px rgba(95,200,245,0.8)",
  } satisfies Partial<CSSStyleDeclaration>);
  const fireLabel = el("span", "fw-hud-fire-label");
  fireLabel.textContent = "FIRE";
  Object.assign(fireLabel.style, {
    fontFamily: FONT.display,
    fontWeight: "900",
    fontSize: "21px",
    letterSpacing: "0.04em",
  } satisfies Partial<CSSStyleDeclaration>);
  const fireSub = el("span", "fw-hud-fire-sub");
  fireSub.textContent = "HOLD TO CHARGE";
  Object.assign(fireSub.style, {
    fontFamily: FONT.mono,
    fontSize: "8px",
    letterSpacing: "0.1em",
    color: "rgba(6, 20, 31, 0.7)",
  } satisfies Partial<CSSStyleDeclaration>);
  fireFace.append(fireLabel, fireSub);
  fireWrap.append(fireHint, fireFace);

  regionActionBar.append(chipsCol, moveWrap, powerWrap, fireWrap);

  // ── end-banner (center, hidden initially) ─────────────────────────────────
  const endBanner = el("div", "fw-hud-endbanner");
  panelStyle(endBanner, 16);
  Object.assign(endBanner.style, {
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
    border: PANEL_BORDER_HOT,
    padding: "var(--space-xl) var(--space-2xl)",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  endBanner.insertAdjacentHTML("afterbegin", edgeBar(4));
  const endWinner = el("div", "fw-hud-endbanner-winner");
  Object.assign(endWinner.style, {
    fontFamily: FONT.display,
    fontWeight: "900",
    fontSize: "24px",
    color: "var(--glow)",
    textShadow: CYAN_GLOW,
  } satisfies Partial<CSSStyleDeclaration>);
  const endSub = el("div", "fw-hud-endbanner-sub");
  endSub.textContent = "RELOAD TO REDEPLOY";
  Object.assign(endSub.style, {
    fontFamily: FONT.alt,
    fontSize: "10px",
    letterSpacing: "0.12em",
    color: "var(--muted)",
    marginTop: "var(--space-sm)",
  } satisfies Partial<CSSStyleDeclaration>);
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
    glyph: HTMLElement;
    label: HTMLElement;
    youBadge: HTMLElement;
    reconnTag: HTMLElement;
    hp: HTMLElement;
  }
  const rowRefs = new Map<string, RowRefs>();

  function buildRow(): RowRefs {
    const rowRoot = el("div", "fw-hud-row");
    Object.assign(rowRoot.style, {
      position: "relative",
      display: "flex",
      alignItems: "center",
      gap: "var(--space-sm)",
      padding: "var(--space-sm) var(--space-sm)",
      fontFamily: FONT.cond,
      fontSize: "12px",
      color: "var(--text-2)",
      transition: "background 120ms, color 120ms",
    } satisfies Partial<CSSStyleDeclaration>);
    // The active-row left edge-bar (mutated visible via display in applyRow).
    const marker = el("span", "fw-hud-row-marker");
    marker.textContent = ""; // ▸ when active
    Object.assign(marker.style, {
      width: "10px",
      fontFamily: FONT.mono,
      fontSize: "11px",
      color: "var(--glow)",
    } satisfies Partial<CSSStyleDeclaration>);
    // Meshed hex identity glyph (team-tinted clip-path token).
    const glyph = el("span", "fw-hud-row-glyph");
    Object.assign(glyph.style, {
      width: "18px",
      height: "18px",
      flex: "0 0 auto",
      clipPath: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
      background: "linear-gradient(135deg, #5fc8f5, #0e7490)",
    } satisfies Partial<CSSStyleDeclaration>);
    const label = el("span", "fw-hud-row-label");
    Object.assign(label.style, {
      flex: "1",
      fontWeight: "600",
      color: "var(--text)",
    } satisfies Partial<CSSStyleDeclaration>);
    const youBadge = el("span", "fw-hud-row-you");
    youBadge.textContent = "YOU";
    Object.assign(youBadge.style, {
      display: "none",
      padding: "0 4px",
      background: "var(--accent)",
      color: "var(--bg-deeper)",
      clipPath: angledTab(16),
      fontFamily: FONT.mono,
      fontSize: "9px",
      fontWeight: "700",
    } satisfies Partial<CSSStyleDeclaration>);
    const reconnTag = el("span", "fw-hud-row-reconnecting");
    // D-06: no reconnection window on Convex — the cue means "tab away/offline".
    reconnTag.textContent = "AWAY";
    Object.assign(reconnTag.style, {
      display: "none",
      fontFamily: FONT.mono,
      color: "var(--warn)",
      fontSize: "10px",
      letterSpacing: "0.04em",
    } satisfies Partial<CSSStyleDeclaration>);
    const hp = el("span", "fw-hud-row-hp fw-num");
    Object.assign(hp.style, {
      marginLeft: "auto",
      fontFamily: FONT.mono,
      fontSize: "10px",
      color: "var(--ready)",
    } satisfies Partial<CSSStyleDeclaration>);
    rowRoot.append(marker, glyph, label, youBadge, reconnTag, hp);
    return { root: rowRoot, marker, glyph, label, youBadge, reconnTag, hp };
  }

  function applyRow(row: HudTurnRow, refs: RowRefs): void {
    // Identity (concern 7): label via textContent (XSS guard); YOU badge gated.
    refs.label.textContent = row.label;
    refs.youBadge.style.display = row.isLocal ? "inline-block" : "none";

    // Team-tinted identity glyph (cyan for team A, threat-red for team B).
    refs.glyph.style.background =
      row.team === 1
        ? "linear-gradient(135deg, #ef4444, #991b1b)"
        : "linear-gradient(135deg, #5fc8f5, #0e7490)";

    // Active styling — cyan field tint + ▸ marker (Meshed active row).
    refs.marker.textContent = row.isActive ? "▸" : "";
    refs.root.style.background = row.isActive ? "rgba(27, 159, 224, 0.14)" : "";

    // Eliminated styling — strike-through + OUT.
    if (row.eliminated) {
      refs.root.style.textDecoration = "line-through";
      refs.root.style.opacity = "0.45";
      refs.glyph.style.background = "#1e293b";
      refs.hp.textContent = "OUT";
      refs.hp.style.color = "var(--danger)";
    } else {
      refs.root.style.textDecoration = "none";
      refs.root.style.opacity = "1";
      // HP NUMBER updates IMMEDIATELY on change (concern 5 — the number is not
      // the impact-aligned signal; the pulse is).
      refs.hp.textContent = String(row.hp);
      // HP-band tinting per the Meshed mockup (good/mid/critical).
      refs.hp.style.color =
        row.hp > 66 ? "var(--ready)" : row.hp > 33 ? "var(--warn)" : "var(--danger)";
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
      bottom: "12px",
      width: "9px",
      height: "9px",
      marginLeft: "-4px",
      borderRadius: "50%",
      background: "var(--muted)",
    } satisfies Partial<CSSStyleDeclaration>);
    return b;
  }

  // ─────────────────────────── pulse helper ──────────────────────────────────

  function pulseRow(id: string, refs: RowRefs): void {
    refs.root.classList.add("fw-hud-row--hit");
    refs.root.style.background = "rgba(239, 68, 68, 0.32)";
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
      chip.style.borderColor = selected ? "var(--glow)" : "rgba(95, 200, 245, 0.18)";
      chip.style.color = selected ? "var(--glow)" : "var(--muted)";
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
    roundBadge.textContent = vm.round < 0 ? "RND —" : `RND ${vm.round}`;

    // Wind value.
    windValue.textContent = String(Math.round(vm.wind));

    // Countdown / active line (UI-02). The VM does not store countdownText — it is
    // the caller's pre-formatted rAF string (concern 6).
    const active = vm.activeLabel + (countdownText ? ` ${countdownText}` : "");
    countdownLine.textContent = active;
    if (vm.activeIsLocal) {
      countdownLine.style.color = "var(--glow)";
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
    // Team-tinted blips (cyan friendly / threat-red enemy), active gets the glow.
    const base = blip.team === 1 ? "#EF4444" : "#5fc8f5";
    node.style.background = blip.isActive ? base : "var(--muted)";
    node.style.opacity = blip.isActive ? "1" : "0.7";
    node.style.boxShadow = blip.isActive ? `0 0 8px ${base}` : "none";
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
