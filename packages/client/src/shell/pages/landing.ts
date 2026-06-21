import { isSignedIn, openSignIn, RETURN_TO_KEY } from "../auth.js";
import { FONT, chamfer, angledTab, edgeBar, circuitRail } from "../meshed.js";

/**
 * Landing page (Design screen 02 → "SCREEN 1 — LANDING (meshed)") — the app entry /
 * gate. Restyled to the founder's NEW "Meshed System" (Phase 6, Plan 06-MESHED-A):
 * SOC-slate field + cyan/violet holo-chrome with the four Meshed motifs — CHAMFER,
 * ANGLED TAB, EDGE-BAR, CIRCUIT RAIL — consumed from the shared `shell/meshed.ts`
 * foundation. The surface keeps the full marketing set built in plan 05 (nav + hero
 * + HOW-IT-PLAYS strip + ROSTER + GAME MODES + ARSENAL + illustrative STATS band +
 * FAQ accordion + FOOTER) but re-skinned to the Meshed language: a chamfered nav bar
 * with a left edge-bar, the `BREACH THE FIREWALL` hero with a circuit-rail stat band,
 * a chamfered hero visual with bracket corners + edge-bars + TARGET-LOCK tags, and
 * chamfered HOW-IT-PLAYS cards (CALIBRATE / FORK & FIRE / BREACH + the FREE-TO-PLAY
 * accent card).
 *
 * RESPONSIVE PASS: the page SCROLLS (overflow-y auto), every section's inner content
 * is wrapped in a centered `container()` max-width helper, multi-column bodies use
 * CSS grid `repeat(auto-fit, minmax(...))`, and display type uses `clamp()` — so the
 * layout reflows on narrow viewports with no dedicated mobile pass.
 *
 * NO-HORIZONTAL-SCROLL (06-RESEARCH Pitfall 7): the negative-offset ambient glows
 * live in a dedicated decoration layer (`position:absolute; inset:0; overflow:hidden;
 * pointer-events:none; z-index:0`) so they are clipped to the viewport and never
 * extend the scroll width. The page sets `overflowX:"hidden"` defensively; content
 * sits above the decoration layer (`z-index:1`).
 *
 * SCOPE TRIM: the STORE/economy nav is OMITTED (economy is out of v0).
 *
 * Auth-gated CTAs (AUTH-01/02): every CTA — `DEPLOY NOW` / `PLAY FREE` / `SIGN IN`
 * / WATCH-TRAILER / roster + mode + footer + FREE-TO-PLAY CTAs — calls the SAME
 * `deploy()`: if signed in, `navigate("/lobby")`; else stash `/lobby` and open the
 * Clerk sign-in surface (after sign-in the router consumes `fwops:returnTo` and lands
 * the user on /lobby). The auth gate is UNCHANGED this phase.
 */

/** The roster callsigns shown on the landing (UI-SPEC Copywriting Contract roster
 * table). The 6th firewall-tank class is intentionally NOT shown. Cosmetic copy only —
 * archetype labels, never fabricated stat numbers. */
const ROSTER: ReadonlyArray<{
  callsign: string;
  archetype: string;
  color: string;
  glyph: string;
  blurb: string;
}> = [
  {
    callsign: "SENTINEL",
    archetype: "ALL-ROUNDER",
    color: "var(--accent)", // cyan
    glyph: "◇",
    blurb:
      "The honest skill pick — dependable arc, light tracking. No hard counter, no hard prey.",
  },
  {
    callsign: "VECTOR",
    archetype: "SNIPER",
    color: "#E879C9", // magenta
    glyph: "◆",
    blurb:
      "Glass-cannon precision. Flat, fast bolts that shred any open sightline — and nothing else.",
  },
  {
    callsign: "CIPHER",
    archetype: "ZONE CONTROL",
    color: "var(--warn)", // gold
    glyph: "◈",
    blurb:
      "The trapper. Pre-place mines and delayed charges; control where the enemy dares to stand.",
  },
  {
    callsign: "DAEMON",
    archetype: "BURROWER",
    color: "var(--ready)", // terminal-green
    glyph: "⬢",
    blurb:
      "Goes through terrain, not over it. The hard counter to anyone turtling behind a hill.",
  },
  {
    callsign: "PROXY",
    archetype: "AREA CONTROL",
    color: "#7CFC6B", // glitch-green
    glyph: "⟁",
    blurb:
      "Splitting, multiplying arcs that blanket open ground. Punishes campers and clusters.",
  },
];

/** Render the landing page into `root`. `navigate` is the router's pushState nav. */
export function renderLanding(
  root: HTMLElement,
  navigate: (path: string) => void,
): void {
  root.innerHTML = "";

  // The CTA action shared by EVERY landing CTA (DEPLOY NOW / PLAY FREE / SIGN IN /
  // WATCH TRAILER / roster / modes / footer / free-to-play): gate on a session —
  // UNCHANGED auth path this phase.
  const deploy = (): void => {
    if (isSignedIn()) {
      navigate("/lobby");
    } else {
      // Stash /lobby as the intended destination so the post-sign-in round-trip
      // lands there (the router's auth listener consumes fwops:returnTo).
      try {
        sessionStorage.setItem(RETURN_TO_KEY, "/lobby");
      } catch {
        /* private mode — return-to just won't persist */
      }
      openSignIn();
    }
  };

  const page = el("div", "fw-landing");
  Object.assign(page.style, {
    minHeight: "100%",
    position: "relative",
    // Page scrolls vertically; overflowX hidden so the clipped glow layer + any
    // reflow rounding can never produce a horizontal scrollbar (Pitfall 7).
    overflowX: "hidden",
    overflowY: "auto",
    background: "var(--bg-deep)", // Meshed field #0B1220
    // Meshed grid texture (faint cyan 48px mesh).
    backgroundImage:
      "linear-gradient(rgba(34,211,238,0.04) 1px, transparent 1px), " +
      "linear-gradient(90deg, rgba(34,211,238,0.04) 1px, transparent 1px)",
    backgroundSize: "48px 48px",
    fontFamily: "var(--font-body)",
    color: "var(--text-2)",
  } satisfies Partial<CSSStyleDeclaration>);

  // ---- clipped decoration layer (ambient glows live here) ----
  // Its own overflow:hidden clips the negative-offset glows to the viewport so they
  // never extend the page scroll width (no horizontal scroll). pointer-events:none
  // keeps it click-through; z-index:0 sits it behind the content (z-index:1).
  const decor = el("div", "fw-landing-decor");
  Object.assign(decor.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  glow(decor, "-200px", "-120px", "760px", "rgba(34,211,238,0.16)", "right", "top");
  glow(decor, "-260px", "-160px", "680px", "rgba(168,85,247,0.12)", "left", "bottom");
  page.appendChild(decor);

  // ---- content layer (sits above the decoration layer) ----
  const content = el("div", "fw-landing-content");
  Object.assign(content.style, {
    position: "relative",
    zIndex: "1",
  } satisfies Partial<CSSStyleDeclaration>);

  // ---- NAV (chamfered bar + left edge-bar) ----
  const navWrap = el("div", "fw-landing-navwrap");
  Object.assign(navWrap.style, {
    position: "relative",
    margin: "18px clamp(16px, 3vw, 24px) 0",
  } satisfies Partial<CSSStyleDeclaration>);

  // The chamfered bar background (absolute fill behind the nav content).
  const navBg = document.createElement("div");
  Object.assign(navBg.style, {
    position: "absolute",
    inset: "0",
    background:
      "linear-gradient(180deg, rgba(18,29,49,0.9), rgba(11,18,32,0.7))",
    border: "1px solid rgba(95,200,245,0.22)",
    clipPath: chamfer(12),
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const nav = el("nav", "fw-landing-nav");
  Object.assign(nav.style, {
    position: "relative",
    minHeight: "60px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    flexWrap: "wrap",
    padding: "10px clamp(16px, 3vw, 24px)",
  } satisfies Partial<CSSStyleDeclaration>);

  const brand = el("div", "fw-brand");
  Object.assign(brand.style, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "18px",
    letterSpacing: "0.08em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  // Hex sigil + wordmark (static chrome).
  brand.innerHTML =
    `<span style="width:30px;height:30px;display:inline-flex;align-items:center;` +
    `justify-content:center;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,` +
    `25% 100%,0 50%);background:linear-gradient(135deg,var(--glow),#0891b2)">` +
    `<span style="width:9px;height:9px;background:var(--bg-deep);clip-path:` +
    `polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)"></span></span>` +
    `<span>FIREWALL<span style="color:var(--accent)">OPS</span></span>`;

  // Info nav items — STORE/economy intentionally OMITTED (scope trim).
  const navLinks = el("div", "fw-nav-links");
  Object.assign(navLinks.style, {
    display: "flex",
    alignItems: "center",
    gap: "30px",
    fontFamily: "var(--font-display)",
    fontWeight: "500",
    fontSize: "11px",
    letterSpacing: "0.1em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  navLinks.innerHTML =
    `<span style="color:var(--text)">GAME</span><span>ROSTER</span>` +
    `<span>RANKED</span><span>UPDATES</span>`;

  const navRight = el("div", "fw-nav-right");
  Object.assign(navRight.style, {
    display: "flex",
    alignItems: "center",
    gap: "18px",
  } satisfies Partial<CSSStyleDeclaration>);

  const signIn = el("button", "fw-signin");
  signIn.type = "button";
  signIn.textContent = "SIGN IN";
  Object.assign(signIn.style, {
    background: "transparent",
    border: "none",
    fontFamily: "var(--font-body)",
    fontSize: "12px",
    letterSpacing: "0.06em",
    color: "var(--text-2)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  signIn.addEventListener("click", deploy);

  // PLAY FREE — angled-tab cyan pill.
  const playFree = el("button", "fw-playfree");
  playFree.type = "button";
  playFree.textContent = "PLAY FREE";
  Object.assign(playFree.style, {
    padding: "9px 22px",
    background: "linear-gradient(180deg,var(--glow),var(--accent))",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "11px",
    letterSpacing: "0.1em",
    border: "none",
    clipPath: angledTab(10),
    boxShadow: "0 0 18px -4px rgba(34,211,238,0.6)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  playFree.addEventListener("click", deploy);

  navRight.append(signIn, playFree);
  nav.append(brand, navLinks, navRight);
  navWrap.append(navBg);
  // Left edge-bar (parent navWrap is position:relative).
  navWrap.insertAdjacentHTML("beforeend", edgeBar(4, 10));
  navWrap.append(nav);

  // ---- HERO ----
  const hero = el("section", "fw-hero");
  Object.assign(hero.style, { position: "relative" } satisfies Partial<CSSStyleDeclaration>);
  const heroInner = container("1280px");
  Object.assign(heroInner.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
    gap: "40px",
    alignItems: "center",
    paddingTop: "clamp(40px, 6vw, 60px)",
    paddingBottom: "clamp(24px, 4vw, 48px)",
  } satisfies Partial<CSSStyleDeclaration>);

  const heroLeft = el("div", "fw-hero-left");

  // Eyebrow badge — angled-tab pill with a green live dot.
  const badge = el("div", "fw-hero-badge");
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 14px",
    background: "rgba(34,211,238,0.06)",
    border: "1px solid rgba(95,200,245,0.35)",
    clipPath: angledTab(8),
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.18em",
    color: "var(--glow)",
    marginBottom: "30px",
  } satisfies Partial<CSSStyleDeclaration>);
  badge.innerHTML =
    `<span style="width:6px;height:6px;background:var(--ready);border-radius:50%;` +
    `box-shadow:0 0 8px var(--ready)"></span> TURN-BASED CYBER ARTILLERY`;

  const h1 = el("h1", "fw-hero-title");
  Object.assign(h1.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "900",
    fontSize: "clamp(44px, 7vw, 74px)",
    lineHeight: "0.96",
    letterSpacing: "-0.01em",
    color: "var(--text)",
    margin: "0 0 8px",
  } satisfies Partial<CSSStyleDeclaration>);
  // Exact copy: BREACH THE FIREWALL, cyan "FIREWALL" (Meshed Landing).
  h1.innerHTML =
    `BREACH<br>THE <span style="color:var(--accent);` +
    `text-shadow:0 0 32px rgba(34,211,238,0.55)">FIREWALL</span>`;

  const sub = el("p", "fw-hero-sub");
  Object.assign(sub.style, {
    fontSize: "15px",
    lineHeight: "1.7",
    color: "var(--text-2)",
    maxWidth: "480px",
    margin: "22px 0 36px",
  } satisfies Partial<CSSStyleDeclaration>);
  sub.textContent =
    "Calibrate the angle. Charge the payload. Read the packet-wind. Land your " +
    "exploit before they patch the breach — a tactical artillery duel skinned " +
    "in pure cyber-warfare.";

  const ctaRow = el("div", "fw-hero-cta");
  Object.assign(ctaRow.style, {
    display: "flex",
    gap: "14px",
    alignItems: "center",
    marginBottom: "46px",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  // DEPLOY NOW — chamfered cyan-glow primary CTA (class fw-btn-primary for the test).
  const deployNow = el("button", "fw-btn-primary");
  deployNow.type = "button";
  deployNow.textContent = "DEPLOY NOW"; // exact copy — the primary focal CTA.
  Object.assign(deployNow.style, {
    padding: "15px 36px",
    background: "linear-gradient(180deg,var(--glow),var(--accent))",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "14px",
    letterSpacing: "0.08em",
    border: "none",
    clipPath: chamfer(10),
    boxShadow: "0 0 32px -6px rgba(34,211,238,0.7)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  deployNow.addEventListener("click", deploy);

  // WATCH TRAILER — chamfered outline CTA (also routes through deploy()).
  const watch = el("button", "fw-hero-watch");
  watch.type = "button";
  Object.assign(watch.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    padding: "15px 28px",
    background: "transparent",
    border: "1px solid rgba(95,200,245,0.3)",
    color: "var(--text)",
    fontFamily: "var(--font-display)",
    fontWeight: "600",
    fontSize: "13px",
    letterSpacing: "0.08em",
    clipPath: chamfer(10),
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  watch.innerHTML = `<span style="color:var(--accent)">▶</span> WATCH TRAILER`;
  watch.addEventListener("click", deploy);

  ctaRow.append(deployNow, watch);

  // ---- HERO stat band with a circuit rail (illustrative-static numbers) ----
  const heroStats = el("div", "fw-hero-stats");
  const rail = el("div", "fw-hero-rail");
  Object.assign(rail.style, { marginBottom: "18px" } satisfies Partial<CSSStyleDeclaration>);
  // Circuit-rail divider (static chrome from the foundation, no caller input).
  rail.innerHTML = circuitRail(false);

  const heroStatsNote = el("div", "fw-hero-stats-note");
  Object.assign(heroStatsNote.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "9px",
    letterSpacing: "0.16em",
    color: "var(--faint)",
    marginBottom: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  heroStatsNote.textContent = "// ILLUSTRATIVE — SAMPLE NETWORK FIGURES";

  const heroStatsGrid = el("div", "fw-hero-stats-grid");
  Object.assign(heroStatsGrid.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "40px",
  } satisfies Partial<CSSStyleDeclaration>);
  heroStatsGrid.appendChild(statCell("48,210", "AGENTS ONLINE", "var(--text)"));
  heroStatsGrid.appendChild(statCell("2.4M", "BREACHES LOGGED", "var(--text)"));
  heroStatsGrid.appendChild(statCell("6", "AGENT CLASSES", "var(--accent)"));
  heroStats.append(rail, heroStatsNote, heroStatsGrid);

  heroLeft.append(badge, h1, sub, ctaRow, heroStats);

  // Right hero visual — chamfered frame + edge-bars + bracket corners + lock tags.
  const heroVisual = el("div", "fw-hero-visual");
  Object.assign(heroVisual.style, {
    position: "relative",
    minHeight: "360px",
  } satisfies Partial<CSSStyleDeclaration>);
  // Chamfered gradient-border frame (1px) wrapping the chamfered field render.
  const frame = document.createElement("div");
  Object.assign(frame.style, {
    position: "absolute",
    inset: "0",
    padding: "1px",
    background:
      "linear-gradient(160deg, rgba(95,200,245,0.5), rgba(40,90,120,0.2))",
    clipPath: chamfer(18),
  } satisfies Partial<CSSStyleDeclaration>);
  frame.innerHTML =
    `<div style="width:100%;height:100%;position:relative;overflow:hidden;` +
    `clip-path:${chamfer(17)};background:linear-gradient(160deg,` +
    `rgba(22,35,60,0.7),rgba(11,18,32,0.3));display:flex;align-items:center;` +
    `justify-content:center;font-family:${FONT.mono};font-size:11px;` +
    `letter-spacing:0.2em;color:var(--faint)">[ FIELD RENDER ]</div>`;
  heroVisual.appendChild(frame);
  // Edge-bars (left + right), bracket corners, and the lock tags — static chrome.
  heroVisual.insertAdjacentHTML(
    "beforeend",
    `<div style="position:absolute;left:-1px;top:40px;bottom:40px;width:3px;` +
      `background:linear-gradient(180deg,transparent,var(--glow),var(--edge),` +
      `transparent);box-shadow:0 0 12px var(--edge)"></div>` +
      `<div style="position:absolute;right:-1px;top:40px;bottom:40px;width:3px;` +
      `background:linear-gradient(180deg,transparent,var(--glow),var(--edge),` +
      `transparent);box-shadow:0 0 12px var(--edge)"></div>` +
      cornerBracket("top", "left") +
      cornerBracket("bottom", "right") +
      `<div style="position:absolute;top:22px;left:46px;font-family:${FONT.mono};` +
      `font-size:10px;letter-spacing:0.16em;color:var(--glow);` +
      `background:rgba(11,18,32,0.7);padding:4px 8px">◢ TARGET LOCK</div>` +
      `<div style="position:absolute;bottom:20px;left:46px;font-family:${FONT.mono};` +
      `font-size:11px;color:var(--text-2);background:rgba(11,18,32,0.7);` +
      `padding:4px 8px">CLASS: SENTINEL · HP 100</div>`,
  );

  heroInner.append(heroLeft, heroVisual);
  hero.appendChild(heroInner);

  // ---- HOW IT PLAYS strip (chamfered cards w/ edge-bar + rail numbers) ----
  const strip = section("fw-howstrip");
  const stripInner = container("1280px");
  stripInner.appendChild(sectionLabel("01 / HOW IT PLAYS", "THE BREACH LOOP"));
  const stripGrid = el("div", "fw-howstrip-grid");
  Object.assign(stripGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "18px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  stripGrid.appendChild(
    howCard("01", "⊹", "CALIBRATE", "var(--accent)", "var(--glow)", "Set angle & power against live packet-wind. Every degree counts."),
  );
  stripGrid.appendChild(
    howCard("02", "⟁", "FORK & FIRE", "var(--accent)", "var(--glow)", "Single Packet, Forked Exploit, or charge the Trojan finisher."),
  );
  stripGrid.appendChild(
    howCard("03", "⊗", "BREACH", "var(--danger)", "#ff7a6a", "Crater the terrain, drain their HP, claim the last node standing."),
  );

  // FREE-TO-PLAY accent card (chamfered, cyan→violet wash, deploy CTA).
  const free = el("div", "fw-howstrip-free");
  Object.assign(free.style, {
    position: "relative",
    background:
      "linear-gradient(135deg, rgba(34,211,238,0.16), rgba(168,85,247,0.12))",
    border: "1px solid rgba(95,200,245,0.35)",
    clipPath: chamfer(12),
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "8px",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  free.innerHTML =
    `<div style="font-family:var(--font-display);font-weight:800;font-size:15px;` +
    `color:var(--text);letter-spacing:0.04em">FREE TO PLAY</div>` +
    `<div style="font-size:12px;line-height:1.6;color:#cfe9f8">No download. ` +
    `Jump into a match in under 30 seconds.</div>` +
    `<div style="margin-top:6px;font-family:var(--font-display);font-size:11px;` +
    `letter-spacing:0.1em;color:var(--glow)">DEPLOY NOW →</div>`;
  free.addEventListener("click", deploy);
  stripGrid.appendChild(free);
  stripInner.appendChild(stripGrid);
  strip.appendChild(stripInner);

  // ---- ROSTER (5 callsigns; the 6th firewall-tank class not shown) ----
  const roster = section("fw-roster");
  const rosterInner = container("1280px");
  rosterInner.appendChild(sectionLabel("02 / THE ROSTER", "PICK YOUR EXPLOIT"));
  const rosterSub = el("p", "fw-roster-sub");
  Object.assign(rosterSub.style, {
    fontSize: "13px",
    lineHeight: "1.7",
    color: "var(--text-2)",
    maxWidth: "520px",
    margin: "14px 0 26px",
  } satisfies Partial<CSSStyleDeclaration>);
  rosterSub.textContent =
    "Every agent class is a playstyle — a signature trajectory with real advantages " +
    "and tradeoffs. No single class dominates; each strength is someone else's prey.";
  const rosterGrid = el("div", "fw-roster-grid");
  Object.assign(rosterGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "16px",
  } satisfies Partial<CSSStyleDeclaration>);
  for (const r of ROSTER) {
    rosterGrid.appendChild(
      rosterCard(r.callsign, r.archetype, r.color, r.glyph, r.blurb, deploy),
    );
  }
  rosterInner.append(rosterSub, rosterGrid);
  roster.appendChild(rosterInner);

  // ---- GAME MODES ----
  const modes = section("fw-modes");
  const modesInner = container("1280px");
  modesInner.appendChild(sectionLabel("03 / GAME MODES", "CHOOSE THE ENGAGEMENT"));
  const modesGrid = el("div", "fw-modes-grid");
  Object.assign(modesGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "18px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  modesGrid.appendChild(
    modeCard("1v1", "DUEL", "Pure skill, no excuses. One agent, one breach, one survivor.", deploy),
  );
  modesGrid.appendChild(
    modeCard("2v2", "FIRETEAM", "Pair up and stack your trajectories — cover, combo, and crater together.", deploy),
  );
  modesGrid.appendChild(
    modeCard("4v4", "RAID", "Eight agents, full chaos. Last team holding a node standing wins the breach.", deploy),
  );
  modesInner.appendChild(modesGrid);
  modes.appendChild(modesInner);

  // ---- ARSENAL + HOW-IT-PLAYS deep-dive ----
  const arsenal = section("fw-arsenal");
  const arsenalInner = container("1280px");
  arsenalInner.appendChild(sectionLabel("04 / THE ARSENAL", "MASTER THE ARTILLERY"));
  const arsenalGrid = el("div", "fw-arsenal-grid");
  Object.assign(arsenalGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "18px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  arsenalGrid.appendChild(
    howCard("◢", "—", "AIM", "var(--accent)", "var(--glow)", "Rotate the muzzle in a constrained arc. Read the line, commit the angle."),
  );
  arsenalGrid.appendChild(
    howCard("▮", "—", "POWER", "var(--accent)", "var(--glow)", "Charge the payload. More power flattens the arc and crosses the gap."),
  );
  arsenalGrid.appendChild(
    howCard("≋", "—", "WIND", "var(--warn)", "var(--warn)", "Live packet-wind drifts every shot. Correct for it or watch it sail."),
  );
  arsenalGrid.appendChild(
    howCard("⊗", "—", "TERRAIN", "var(--danger)", "#ff7a6a", "Every hit craters the field. Destructible cover reshapes the duel turn by turn."),
  );
  arsenalInner.appendChild(arsenalGrid);
  arsenal.appendChild(arsenalInner);

  // ---- FAQ (native <details>/<summary> accordion — no JS framework) ----
  const faq = section("fw-faq");
  const faqInner = container("860px");
  faqInner.appendChild(sectionLabel("05 / INTEL", "FREQUENTLY ASKED"));
  const faqList = el("div", "fw-faq-list");
  Object.assign(faqList.style, {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  faqList.appendChild(
    faqItem(
      "Is it really free to play?",
      "Yes. No download, no install — jump into a match straight from the browser in under 30 seconds.",
    ),
  );
  faqList.appendChild(
    faqItem(
      "What kind of game is this?",
      "A turn-based artillery duel — calibrate angle and power, read the wind, and breach the enemy across destructible terrain. Skinned in pure cyber-warfare.",
    ),
  );
  faqList.appendChild(
    faqItem(
      "Do I need an account?",
      "You sign in to deploy so your matches and standing persist. The sign-in surface opens the moment you hit any DEPLOY CTA.",
    ),
  );
  faqList.appendChild(
    faqItem(
      "How many agent classes are there?",
      "Six distinct classes are in design, each a different trajectory and playstyle. The roster rolls out over time.",
    ),
  );
  faqInner.appendChild(faqList);
  faq.appendChild(faqInner);

  // ---- FOOTER + FINAL CTA ----
  const footer = el("footer", "fw-footer");
  Object.assign(footer.style, {
    position: "relative",
    marginTop: "clamp(40px, 6vw, 72px)",
    borderTop: "1px solid var(--line-faint)",
    background: "var(--bg-deep)",
  } satisfies Partial<CSSStyleDeclaration>);
  const footerInner = container("1280px");
  Object.assign(footerInner.style, {
    paddingTop: "clamp(40px, 5vw, 64px)",
    paddingBottom: "clamp(40px, 5vw, 64px)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "20px",
    textAlign: "center",
  } satisfies Partial<CSSStyleDeclaration>);

  const footerTitle = el("h2", "fw-footer-title");
  Object.assign(footerTitle.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "900",
    fontSize: "clamp(28px, 5vw, 48px)",
    lineHeight: "1.05",
    letterSpacing: "-0.01em",
    color: "var(--text)",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  footerTitle.innerHTML =
    `READY TO <span style="color:var(--accent);` +
    `text-shadow:0 0 32px rgba(34,211,238,0.55)">BREACH</span>?`;

  const footerSub = el("p", "fw-footer-sub");
  Object.assign(footerSub.style, {
    fontSize: "13px",
    lineHeight: "1.7",
    color: "var(--text-2)",
    maxWidth: "440px",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  footerSub.textContent =
    "The firewall won't breach itself. Deploy your agent and land the first exploit.";

  // Final CTA — chamfered cyan-glow primary.
  const footerCta = el("button", "fw-footer-cta");
  footerCta.type = "button";
  footerCta.textContent = "DEPLOY NOW";
  Object.assign(footerCta.style, {
    padding: "15px 36px",
    background: "linear-gradient(180deg,var(--glow),var(--accent))",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "14px",
    letterSpacing: "0.08em",
    border: "none",
    clipPath: chamfer(10),
    boxShadow: "0 0 32px -6px rgba(34,211,238,0.7)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  footerCta.addEventListener("click", deploy);

  const footerMeta = el("div", "fw-footer-meta");
  Object.assign(footerMeta.style, {
    marginTop: "12px",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.14em",
    color: "var(--faint)",
  } satisfies Partial<CSSStyleDeclaration>);
  footerMeta.innerHTML =
    `FIREWALL<span style="color:var(--accent)">OPS</span> · TURN-BASED CYBER ARTILLERY`;

  footerInner.append(footerTitle, footerSub, footerCta, footerMeta);
  footer.appendChild(footerInner);

  content.append(
    navWrap,
    hero,
    strip,
    roster,
    modes,
    arsenal,
    faq,
    footer,
  );
  page.appendChild(content);
  root.appendChild(page);
}

/** A centered max-width wrapper (the landing's responsive `container()` helper). */
function container(maxWidth = "1280px"): HTMLElement {
  const c = document.createElement("div");
  Object.assign(c.style, {
    width: "100%",
    maxWidth,
    margin: "0 auto",
    padding: "0 clamp(20px, 4vw, 44px)",
  } satisfies Partial<CSSStyleDeclaration>);
  return c;
}

/** A vertically-padded landing section wrapper. */
function section(className: string): HTMLElement {
  const s = el("section", className);
  Object.assign(s.style, {
    position: "relative",
    paddingTop: "clamp(40px, 6vw, 72px)",
    paddingBottom: "clamp(24px, 4vw, 48px)",
  } satisfies Partial<CSSStyleDeclaration>);
  return s;
}

/** A section eyebrow label + heading pair (the SOC section header motif). */
function sectionLabel(eyebrow: string, heading: string): HTMLElement {
  const wrap = document.createElement("div");
  const eb = document.createElement("div");
  Object.assign(eb.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    letterSpacing: "0.18em",
    color: "var(--glow)",
    marginBottom: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  eb.textContent = eyebrow;
  const h = document.createElement("h2");
  Object.assign(h.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "clamp(22px, 3vw, 34px)",
    letterSpacing: "0.02em",
    color: "var(--text)",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  h.textContent = heading;
  wrap.append(eb, h);
  return wrap;
}

/** A single illustrative-static stat cell (numeral + label). */
function statCell(value: string, label: string, valueColor: string): HTMLElement {
  const cell = document.createElement("div");
  const num = document.createElement("div");
  Object.assign(num.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "clamp(24px, 4vw, 28px)",
    color: valueColor,
  } satisfies Partial<CSSStyleDeclaration>);
  num.textContent = value;
  const lbl = document.createElement("div");
  Object.assign(lbl.style, {
    fontSize: "10px",
    letterSpacing: "0.12em",
    color: "var(--faint)",
    marginTop: "2px",
  } satisfies Partial<CSSStyleDeclaration>);
  lbl.textContent = label;
  cell.append(num, lbl);
  return cell;
}

/** A roster agent-class card (chamfered, accent edge-bar). `accent` is the class's
 * signature color. */
function rosterCard(
  callsign: string,
  archetype: string,
  accent: string,
  glyph: string,
  blurb: string,
  deploy: () => void,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "relative",
    background:
      "linear-gradient(180deg,rgba(18,29,49,0.6),rgba(11,18,32,0.5))",
    border: "1px solid rgba(95,200,245,0.15)",
    clipPath: chamfer(12),
    padding: "22px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  // Accent edge-bar in the class's signature color (parent is position:relative).
  card.insertAdjacentHTML(
    "afterbegin",
    `<div style="position:absolute;left:0;top:10px;bottom:10px;width:3px;` +
      `background:${accent}"></div>`,
  );

  const top = document.createElement("div");
  Object.assign(top.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } satisfies Partial<CSSStyleDeclaration>);
  const glyphEl = document.createElement("span");
  Object.assign(glyphEl.style, { fontSize: "20px", color: accent } satisfies Partial<CSSStyleDeclaration>);
  glyphEl.textContent = glyph;
  const arch = document.createElement("span");
  Object.assign(arch.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "9px",
    letterSpacing: "0.14em",
    color: "var(--faint)",
  } satisfies Partial<CSSStyleDeclaration>);
  arch.textContent = archetype;
  top.append(glyphEl, arch);

  const name = document.createElement("div");
  Object.assign(name.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "17px",
    letterSpacing: "0.06em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  name.textContent = callsign;

  const body = document.createElement("div");
  Object.assign(body.style, {
    fontSize: "11px",
    lineHeight: "1.6",
    color: "var(--text-2)",
    flex: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  body.textContent = blurb;

  const cta = document.createElement("div");
  Object.assign(cta.style, {
    marginTop: "4px",
    fontFamily: "var(--font-display)",
    fontSize: "10px",
    letterSpacing: "0.1em",
    color: accent,
  } satisfies Partial<CSSStyleDeclaration>);
  cta.textContent = "DEPLOY →";

  card.append(top, name, body, cta);
  card.addEventListener("click", deploy);
  return card;
}

/** A game-mode card with a deploy CTA (chamfered). */
function modeCard(
  tag: string,
  title: string,
  blurb: string,
  deploy: () => void,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "relative",
    background:
      "linear-gradient(180deg,rgba(18,29,49,0.6),rgba(11,18,32,0.5))",
    border: "1px solid rgba(95,200,245,0.15)",
    clipPath: chamfer(12),
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } satisfies Partial<CSSStyleDeclaration>);

  const tagEl = document.createElement("div");
  Object.assign(tagEl.style, {
    fontFamily: "var(--font-mono)",
    fontSize: "clamp(28px, 4vw, 40px)",
    color: "var(--accent)",
    lineHeight: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  tagEl.textContent = tag;

  const titleEl = document.createElement("div");
  Object.assign(titleEl.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "16px",
    letterSpacing: "0.04em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  titleEl.textContent = title;

  const blurbEl = document.createElement("div");
  Object.assign(blurbEl.style, {
    fontSize: "11px",
    lineHeight: "1.6",
    color: "var(--text-2)",
    flex: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  blurbEl.textContent = blurb;

  const cta = el("button", "fw-mode-cta");
  cta.type = "button";
  cta.textContent = "DEPLOY ▸";
  Object.assign(cta.style, {
    alignSelf: "flex-start",
    marginTop: "4px",
    padding: "10px 20px",
    background: "transparent",
    color: "var(--accent)",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "11px",
    letterSpacing: "0.1em",
    border: "1px solid rgba(95,200,245,0.3)",
    clipPath: angledTab(9),
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  cta.addEventListener("click", deploy);

  card.append(tagEl, titleEl, blurbEl, cta);
  return card;
}

/** A native `<details>`/`<summary>` FAQ accordion item (no JS framework). */
function faqItem(question: string, answer: string): HTMLElement {
  const details = document.createElement("details");
  Object.assign(details.style, {
    background:
      "linear-gradient(180deg,rgba(18,29,49,0.6),rgba(11,18,32,0.5))",
    border: "1px solid rgba(95,200,245,0.15)",
    clipPath: chamfer(12),
    padding: "16px 18px",
  } satisfies Partial<CSSStyleDeclaration>);

  const summary = document.createElement("summary");
  Object.assign(summary.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "600",
    fontSize: "13px",
    letterSpacing: "0.02em",
    color: "var(--text)",
    cursor: "pointer",
    listStyle: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  summary.textContent = question;

  const body = document.createElement("div");
  Object.assign(body.style, {
    fontSize: "12px",
    lineHeight: "1.7",
    color: "var(--text-2)",
    marginTop: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  body.textContent = answer;

  details.append(summary, body);
  return details;
}

/** A HOW-IT-PLAYS / arsenal card (chamfered + left edge-bar; number-or-glyph,
 * accent glyph, title, body). All call-site values are STATIC literals (no
 * dynamic/user data) — safe to assemble via innerHTML. */
function howCard(
  num: string,
  glyph: string,
  title: string,
  glyphColor: string,
  barColor: string,
  body: string,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "relative",
    background:
      "linear-gradient(180deg,rgba(18,29,49,0.6),rgba(11,18,32,0.5))",
    border: "1px solid rgba(95,200,245,0.15)",
    clipPath: chamfer(12),
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  card.innerHTML =
    `<div style="position:absolute;left:0;top:10px;bottom:10px;width:3px;` +
    `background:linear-gradient(180deg,${barColor},var(--edge))"></div>` +
    `<div style="display:flex;justify-content:space-between;align-items:center">` +
    `<span style="font-family:var(--font-mono);color:${barColor};font-size:13px">${num}</span>` +
    `<span style="font-size:18px;color:${glyphColor}">${glyph}</span></div>` +
    `<div style="font-family:var(--font-display);font-weight:700;font-size:15px;` +
    `color:var(--text);letter-spacing:0.04em">${title}</div>` +
    `<div style="font-size:12px;line-height:1.6;color:var(--text-2)">${body}</div>`;
  return card;
}

/** A decorative corner bracket (the Meshed HUD-frame motif). */
function cornerBracket(vert: "top" | "bottom", side: "left" | "right"): string {
  const v = vert === "top" ? "top:8px" : "bottom:8px";
  const h = side === "left" ? "left:8px" : "right:8px";
  const bv = vert === "top" ? "border-top" : "border-bottom";
  const bh = side === "left" ? "border-left" : "border-right";
  return (
    `<div style="position:absolute;${v};${h};width:22px;height:22px;` +
    `${bv}:2px solid var(--glow);${bh}:2px solid var(--glow)"></div>`
  );
}

/**
 * A decorative radial glow appended into the clipped decoration `layer` (Pitfall 7:
 * the glows live inside an overflow-hidden layer so their negative offsets never
 * extend the page scroll width).
 */
function glow(
  layer: HTMLElement,
  top: string,
  side: string,
  size: string,
  color: string,
  sideName: "left" | "right",
  vertName: "top" | "bottom",
): void {
  const g = document.createElement("div");
  Object.assign(g.style, {
    position: "absolute",
    width: size,
    height: size,
    background: `radial-gradient(circle, ${color}, transparent 63%)`,
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  g.style[vertName] = top;
  g.style[sideName] = side;
  layer.appendChild(g);
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
