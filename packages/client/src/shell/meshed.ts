/*
 * meshed.ts — the shared "Meshed System" design foundation (Phase 6).
 *
 * A pure, framework-free helper module (no Phaser / Colyseus / DOM-event imports).
 * It exposes the founder's Meshed kit as data + string helpers so every restyled
 * shell page (landing, home-hub, lobby-room, in-game HUD) consumes ONE source of
 * truth for the palette, the type stack, and the four chrome motifs:
 *
 *   CHAMFER      — the 8-point chamfered (cut-corner) clip-path used on frames,
 *                  panels, cards, and the nav bar.
 *   ANGLED TAB   — the parallelogram clip-path used on pills, buttons, ranked tags.
 *   EDGE-BAR     — the glowing vertical bar pinned to the left of a panel.
 *   CIRCUIT RAIL — the dashed `//` divider rail used as a section header break.
 *
 * SOURCE: .planning/phases/06-polish-hardened-deploy/06-MESHED-DESIGN.dc.html
 * (SYSTEM LEGEND / "01 · The meshed kit"). Values are translated verbatim from the
 * legend's hardcoded inline styles into named constants.
 *
 * XSS-SAFETY CONTRACT: `edgeBar()` and `circuitRail()` emit STATIC chrome markup
 * only — they interpolate no caller input. Any dynamic / user-controlled text MUST
 * be set by the caller via `element.textContent` (never concatenated into these
 * helper strings or assigned through innerHTML alongside untrusted data).
 */

/**
 * The Meshed palette. SOC-slate field + cyan/violet holo-chrome accents.
 * Keys mirror the legend's PALETTE swatch row plus the named state colors.
 *
 * Note: many of these also exist as CSS custom properties in shell.css
 * (`--accent`, `--glow`, `--edge`, `--violet`, `--violet-2`, `--ready`, …). Prefer
 * the CSS vars inside style strings for theme-ability; use `MESH` when you need the
 * literal hex in TypeScript logic (e.g. canvas, gradients built in code).
 */
export const MESH = {
  field: "#0B1220", // page field / deepest background
  panel: "#111c30", // panel surface
  panel2: "#121d31", // raised panel (gradient top)
  cyan: "#22D3EE", // the functional cyan accent
  glow: "#5fc8f5", // glow — edge-bar top / chamfer hairline / rail
  edge: "#1B9FE0", // edge — edge-bar bottom
  violet: "#A855F7", // rank / secondary identity accent
  violet2: "#c084fc", // lighter violet — season / diamond tags
  ok: "#22C55E", // success / online / ready
  threat: "#EF4444", // danger / threat / red-team
  amber: "#F59E0B", // warning / away / patch notes
  ink: "#eaf6ff", // primary copy / headings
  text: "#9fb4c4", // body / running text
  mute: "#5b7186", // labels / secondary meta
  muteDeep: "#46637a", // tertiary / faint mono meta
} as const;

/**
 * The Meshed type stack. Ready-to-assign `font-family` strings.
 *   display — Orbitron, all headlines / CTAs / nav.
 *   body    — Saira, running text (the Meshed body font; shell.css --font-body).
 *   mono    — Share Tech Mono, numerics / data readouts / terminal meta.
 *   alt     — Aldrich, alt headings (lobby-room title).
 *   cond    — Saira Condensed, dense tags / tight labels.
 */
export const FONT = {
  display: "'Orbitron', sans-serif",
  body: "'Saira', sans-serif",
  mono: "'Share Tech Mono', monospace",
  alt: "'Aldrich', sans-serif",
  cond: "'Saira Condensed', sans-serif",
} as const;

/**
 * CHAMFER motif — the 8-point chamfered (cut-corner) clip-path polygon.
 * `c` is the corner-cut size in px (legend default 12; 10/14/16/17/18 also used).
 * Assign to `clip-path`. The frame/panel keeps a 1px Meshed hairline border for the
 * lit-edge look (`border:1px solid rgba(95,200,245,0.18)` in the legend).
 *
 * @example el.style.clipPath = chamfer();      // 12px cut
 * @example el.style.clipPath = chamfer(16);    // 16px cut (hero panels)
 */
export function chamfer(c = 12): string {
  return (
    `polygon(0 ${c}px, ${c}px 0, calc(100% - ${c}px) 0, 100% ${c}px, ` +
    `100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, ${c}px 100%, ` +
    `0 calc(100% - ${c}px))`
  );
}

/**
 * ANGLED TAB motif — the parallelogram / angled-tab clip-path.
 * `s` is the horizontal skew as a percentage of width (legend default 10; the
 * legend uses 8/10/16 across pills, PLAY-FREE button, and ranked tags).
 * Assign to `clip-path`.
 *
 * @example el.style.clipPath = angledTab();    // 10% skew (buttons/pills)
 * @example el.style.clipPath = angledTab(16);  // 16% skew (badge)
 */
export function angledTab(s = 10): string {
  return `polygon(${s}% 0, 100% 0, ${100 - s}% 100%, 0 100%)`;
}

/**
 * EDGE-BAR motif — returns an HTML string for the glowing left edge-bar element.
 *
 * POSITIONING CONTRACT: the returned element is `position:absolute; left:0`, so the
 * PARENT it is inserted into MUST be `position:relative` (or otherwise positioned).
 * It spans `top:10px → bottom:10px` (inset from the chamfered corners) and glows in
 * the glow→edge gradient. Insert it as a sibling at the start of a relative panel,
 * e.g. `panel.insertAdjacentHTML("afterbegin", edgeBar())`.
 *
 * Static markup only — safe to use with innerHTML / insertAdjacentHTML.
 *
 * @param width  bar thickness in px (legend uses 3 on cards, 4 on nav/hero).
 * @param inset  top/bottom inset in px from the panel edges (legend default 10).
 */
export function edgeBar(width = 3, inset = 10): string {
  return (
    `<div style="position:absolute; left:0; top:${inset}px; bottom:${inset}px; ` +
    `width:${width}px; background:linear-gradient(180deg, var(--glow), var(--edge)); ` +
    `box-shadow:0 0 12px var(--edge); pointer-events:none;"></div>`
  );
}

/**
 * CIRCUIT RAIL motif — returns an HTML string for the dashed `//` divider rail:
 * a flex row of [dashed line] + [diamond node] + [Orbitron `//`]. Drop it where you
 * want a section-break or stat-band lead-in. The container is `display:flex` and
 * fills its parent's width; the dashed line flexes to fill remaining space.
 *
 * Static markup only — safe to use with innerHTML / insertAdjacentHTML.
 *
 * @param withNode  include the rotated-diamond node before the `//` (legend header
 *                  rail shows it; the hero stat-rail omits it). Default true.
 */
export function circuitRail(withNode = true): string {
  const dash =
    `<div style="flex:1; height:1px; background:repeating-linear-gradient(90deg, ` +
    `rgba(95,200,245,0.5) 0 6px, transparent 6px 12px);"></div>`;
  const node = withNode
    ? `<span style="width:6px; height:6px; border:1px solid var(--glow); ` +
      `transform:rotate(45deg);"></span>`
    : "";
  const mark =
    `<span style="font-family:${FONT.display}; color:var(--glow); ` +
    `font-size:11px; line-height:1;">//</span>`;
  return (
    `<div style="display:flex; align-items:center; gap:8px; width:100%;">` +
    `${dash}${node}${mark}</div>`
  );
}
