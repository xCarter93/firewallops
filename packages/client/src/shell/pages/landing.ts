import { isSignedIn, openSignIn, RETURN_TO_KEY } from "../auth.js";

/**
 * Landing page (Design screen 02, UI-SPEC Screen Inventory #1) — the app entry /
 * gate. Restyled to the founder's Claude Design Landing 02 and extended to the full
 * marketing surface (Phase 6, Plan 05): nav + hero (`BREACH THE FIREWALL` headline,
 * `DEPLOY NOW` cyan-glow CTA) + HOW-IT-PLAYS strip + ROSTER (5 callsigns) + GAME
 * MODES + ARSENAL deep-dive + an illustrative-static STATS band + an FAQ `<details>`
 * accordion + FOOTER with a final CTA. Exact hero copy from the UI-SPEC Copywriting
 * Contract.
 *
 * RESPONSIVE PASS (UI-SPEC §Spacing "Landing responsiveness"): the page now SCROLLS
 * (overflow off `"hidden"`), every section's inner content is wrapped in a centered
 * `container()` max-width helper, multi-column bodies use CSS grid
 * `repeat(auto-fit, minmax(...))`, and display type uses `clamp()` — so the layout
 * reflows on narrow viewports with no dedicated mobile pass.
 *
 * NO-HORIZONTAL-SCROLL (06-RESEARCH Pitfall 7): removing the page-level
 * `overflow:hidden` exposes the negative-offset ambient `glow()` divs. They are
 * moved OUT of page flow into a dedicated decoration layer
 * (`position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:0`),
 * so they are clipped to the viewport and never extend the scroll width. The page
 * sets `overflowX: "hidden"` defensively; content sits above the decoration layer
 * (`z-index:1`).
 *
 * SCOPE TRIM (UI-SPEC): the STORE/economy nav is OMITTED (economy is out of v0).
 *
 * Auth-gated CTAs (AUTH-01/02): every CTA — `DEPLOY NOW` / `PLAY FREE` / `SIGN IN`
 * / roster + mode + footer CTAs — calls the SAME `deploy()`: if signed in,
 * `navigate("/lobby")`; else stash `/lobby` and open the Clerk sign-in surface
 * (after sign-in the router consumes `fwops:returnTo` and lands the user on /lobby).
 * The auth gate is UNCHANGED this phase.
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
  // roster / modes / footer): gate on a session — UNCHANGED auth path this phase.
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
    background: "var(--bg)",
    backgroundImage:
      "linear-gradient(rgba(34,211,238,0.035) 1px, transparent 1px), " +
      "linear-gradient(90deg, rgba(34,211,238,0.035) 1px, transparent 1px)",
    backgroundSize: "48px 48px",
    fontFamily: "var(--font-body)",
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

  // ---- NAV ----
  const nav = el("nav", "fw-landing-nav");
  Object.assign(nav.style, {
    position: "relative",
    minHeight: "74px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    flexWrap: "wrap",
    padding: "16px clamp(20px, 4vw, 44px)",
    borderBottom: "1px solid var(--line-faint)",
  } satisfies Partial<CSSStyleDeclaration>);

  const brand = el("div", "fw-brand");
  Object.assign(brand.style, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    fontFamily: "var(--font-display)",
    fontWeight: "800",
    fontSize: "19px",
    letterSpacing: "0.08em",
    color: "var(--text)",
  } satisfies Partial<CSSStyleDeclaration>);
  brand.innerHTML = `FIREWALL<span style="color:var(--accent)">OPS</span>`;

  // Info nav items — STORE/economy intentionally OMITTED (scope trim).
  const navLinks = el("div", "fw-nav-links");
  Object.assign(navLinks.style, {
    display: "flex",
    alignItems: "center",
    gap: "34px",
    fontSize: "12px",
    letterSpacing: "0.08em",
    color: "var(--muted)",
  } satisfies Partial<CSSStyleDeclaration>);
  navLinks.innerHTML =
    `<span style="color:var(--text)">GAME</span><span>ROSTER</span>` +
    `<span>RANKED</span><span>UPDATES</span>`;

  const navRight = el("div", "fw-nav-right");
  Object.assign(navRight.style, {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  } satisfies Partial<CSSStyleDeclaration>);

  const signIn = el("button", "fw-signin");
  signIn.type = "button";
  signIn.textContent = "SIGN IN";
  Object.assign(signIn.style, {
    background: "transparent",
    border: "none",
    fontFamily: "var(--font-body)",
    fontSize: "12px",
    letterSpacing: "0.08em",
    color: "var(--muted)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  signIn.addEventListener("click", deploy);

  const playFree = el("button", "fw-playfree");
  playFree.type = "button";
  playFree.textContent = "PLAY FREE";
  Object.assign(playFree.style, {
    padding: "10px 22px",
    background: "var(--accent)",
    color: "var(--bg-deeper)",
    fontFamily: "var(--font-display)",
    fontWeight: "700",
    fontSize: "12px",
    letterSpacing: "0.1em",
    border: "none",
    borderRadius: "var(--radius-3)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  playFree.addEventListener("click", deploy);

  navRight.append(signIn, playFree);
  nav.append(brand, navLinks, navRight);

  // ---- HERO ----
  const hero = el("section", "fw-hero");
  Object.assign(hero.style, { position: "relative" } satisfies Partial<CSSStyleDeclaration>);
  const heroInner = container("1200px");
  Object.assign(heroInner.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
    gap: "40px",
    alignItems: "center",
    paddingTop: "clamp(40px, 6vw, 72px)",
    paddingBottom: "clamp(24px, 4vw, 48px)",
  } satisfies Partial<CSSStyleDeclaration>);

  const heroLeft = el("div", "fw-hero-left");

  const badge = el("div", "fw-hero-badge");
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    border: "1px solid rgba(34,211,238,0.35)",
    borderRadius: "var(--radius-2)",
    fontSize: "10px",
    letterSpacing: "0.2em",
    color: "var(--accent)",
    marginBottom: "30px",
  } satisfies Partial<CSSStyleDeclaration>);
  badge.innerHTML =
    `<span style="width:6px;height:6px;background:var(--ready);border-radius:50%;` +
    `box-shadow:0 0 8px var(--ready)"></span> TURN-BASED CYBER ARTILLERY`;

  const h1 = el("h1", "fw-hero-title");
  Object.assign(h1.style, {
    fontFamily: "var(--font-display)",
    fontWeight: "900",
    fontSize: "clamp(40px, 7vw, 74px)",
    lineHeight: "0.96",
    letterSpacing: "-0.01em",
    color: "var(--text)",
    margin: "0 0 8px",
  } satisfies Partial<CSSStyleDeclaration>);
  // Exact copy: BREACH THE FIREWALL (UI-SPEC Copywriting Contract).
  h1.innerHTML =
    `BREACH<br>THE <span style="color:var(--accent);` +
    `text-shadow:0 0 32px rgba(34,211,238,0.5)">FIREWALL</span>`;

  const sub = el("p", "fw-hero-sub");
  Object.assign(sub.style, {
    fontSize: "15px",
    lineHeight: "1.7",
    color: "var(--muted)",
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
    marginBottom: "0",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const deployNow = el("button", "fw-btn-primary");
  deployNow.type = "button";
  deployNow.textContent = "DEPLOY NOW"; // exact copy — the primary focal CTA.
  deployNow.addEventListener("click", deploy);

  ctaRow.appendChild(deployNow);
  heroLeft.append(badge, h1, sub, ctaRow);

  // Right hero visual — the corner-bracket HUD frame from the mockup (decorative).
  const heroVisual = el("div", "fw-hero-visual");
  Object.assign(heroVisual.style, {
    position: "relative",
    minHeight: "320px",
    borderRadius: "var(--radius-6)",
    overflow: "hidden",
    border: "1px solid rgba(34,211,238,0.2)",
    background:
      "linear-gradient(160deg, rgba(30,41,59,0.6), rgba(15,23,42,0.2))",
  } satisfies Partial<CSSStyleDeclaration>);
  heroVisual.innerHTML =
    cornerBracket("top", "left") +
    cornerBracket("top", "right") +
    cornerBracket("bottom", "left") +
    cornerBracket("bottom", "right") +
    `<div style="position:absolute;top:24px;left:24px;font-size:10px;` +
    `letter-spacing:0.18em;color:var(--accent);background:rgba(15,23,42,0.7);` +
    `padding:4px 8px">◢ TARGET LOCK</div>` +
    `<div style="position:absolute;bottom:22px;right:24px;` +
    `font-family:var(--font-mono);font-size:11px;color:var(--muted);` +
    `background:rgba(15,23,42,0.7);padding:4px 8px">CLASS: SENTINEL · HP 100</div>` +
    `<div style="position:absolute;inset:0;display:flex;align-items:center;` +
    `justify-content:center;font-family:var(--font-mono);font-size:11px;` +
    `letter-spacing:0.2em;color:var(--faint)">[ FIELD RENDER ]</div>`;

  heroInner.append(heroLeft, heroVisual);
  hero.appendChild(heroInner);

  // ---- STATS BAND (clearly-illustrative STATIC numbers — never live counts) ----
  const stats = section("fw-stats");
  const statsInner = container("1200px");
  Object.assign(statsInner.style, {
    paddingTop: "clamp(24px, 4vw, 40px)",
    paddingBottom: "clamp(24px, 4vw, 40px)",
  } satisfies Partial<CSSStyleDeclaration>);
  const statsNote = el("div", "fw-stats-note");
  Object.assign(statsNote.style, {
    fontSize: "9px",
    letterSpacing: "0.16em",
    color: "var(--faint)",
    marginBottom: "16px",
  } satisfies Partial<CSSStyleDeclaration>);
  statsNote.textContent = "// ILLUSTRATIVE — SAMPLE NETWORK FIGURES";
  const statsGrid = el("div", "fw-stats-grid");
  Object.assign(statsGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "24px",
    borderTop: "1px solid var(--line-faint)",
    paddingTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  statsGrid.appendChild(statCell("48,210", "AGENTS ONLINE", "var(--text)"));
  statsGrid.appendChild(statCell("2.4M", "BREACHES LOGGED", "var(--text)"));
  statsGrid.appendChild(statCell("6", "AGENT CLASSES", "var(--accent)"));
  statsInner.append(statsNote, statsGrid);
  stats.appendChild(statsInner);

  // ---- HOW IT PLAYS strip ----
  const strip = section("fw-howstrip");
  const stripInner = container("1200px");
  stripInner.appendChild(sectionLabel("01 / HOW IT PLAYS", "THE BREACH LOOP"));
  const stripGrid = el("div", "fw-howstrip-grid");
  Object.assign(stripGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "18px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  stripGrid.appendChild(
    howCard("01", "⊹", "CALIBRATE", "var(--accent)", "Set angle & power against live packet-wind. Every degree counts."),
  );
  stripGrid.appendChild(
    howCard("02", "⟁", "FORK & FIRE", "var(--accent)", "Single Packet, Forked Exploit, or charge the Trojan finisher."),
  );
  stripGrid.appendChild(
    howCard("03", "⊗", "BREACH", "var(--danger)", "Crater the terrain, drain their HP, claim the last node standing."),
  );

  const free = el("div", "fw-howstrip-free");
  Object.assign(free.style, {
    background: "linear-gradient(135deg, rgba(34,211,238,0.14), rgba(168,85,247,0.1))",
    border: "1px solid rgba(34,211,238,0.3)",
    borderRadius: "var(--radius-4)",
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
    `<div style="font-size:11px;line-height:1.6;color:var(--text-2)">No download. ` +
    `Jump into a match in under 30 seconds.</div>` +
    `<div style="margin-top:6px;font-size:11px;letter-spacing:0.1em;color:var(--accent)">DEPLOY NOW →</div>`;
  free.addEventListener("click", deploy);
  stripGrid.appendChild(free);
  stripInner.appendChild(stripGrid);
  strip.appendChild(stripInner);

  // ---- ROSTER (5 callsigns; the 6th firewall-tank class not shown) ----
  const roster = section("fw-roster");
  const rosterInner = container("1200px");
  rosterInner.appendChild(
    sectionLabel("02 / THE ROSTER", "PICK YOUR EXPLOIT"),
  );
  const rosterSub = el("p", "fw-roster-sub");
  Object.assign(rosterSub.style, {
    fontSize: "13px",
    lineHeight: "1.7",
    color: "var(--muted)",
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
  const modesInner = container("1200px");
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
  const arsenalInner = container("1200px");
  arsenalInner.appendChild(sectionLabel("04 / THE ARSENAL", "MASTER THE ARTILLERY"));
  const arsenalGrid = el("div", "fw-arsenal-grid");
  Object.assign(arsenalGrid.style, {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "18px",
    marginTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);
  arsenalGrid.appendChild(
    howCard("◢", "—", "AIM", "var(--accent)", "Rotate the muzzle in a constrained arc. Read the line, commit the angle."),
  );
  arsenalGrid.appendChild(
    howCard("▮", "—", "POWER", "var(--accent)", "Charge the payload. More power flattens the arc and crosses the gap."),
  );
  arsenalGrid.appendChild(
    howCard("≋", "—", "WIND", "var(--warn)", "Live packet-wind drifts every shot. Correct for it or watch it sail."),
  );
  arsenalGrid.appendChild(
    howCard("⊗", "—", "TERRAIN", "var(--danger)", "Every hit craters the field. Destructible cover reshapes the duel turn by turn."),
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
  const footerInner = container("1200px");
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
    `text-shadow:0 0 32px rgba(34,211,238,0.5)">BREACH</span>?`;

  const footerSub = el("p", "fw-footer-sub");
  Object.assign(footerSub.style, {
    fontSize: "13px",
    lineHeight: "1.7",
    color: "var(--muted)",
    maxWidth: "440px",
    margin: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  footerSub.textContent =
    "The firewall won't breach itself. Deploy your agent and land the first exploit.";

  const footerCta = el("button", "fw-btn-primary");
  footerCta.type = "button";
  footerCta.textContent = "DEPLOY NOW";
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
    nav,
    hero,
    stats,
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
function container(maxWidth = "1200px"): HTMLElement {
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
    color: "var(--accent)",
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
    fontSize: "clamp(24px, 4vw, 32px)",
    color: valueColor,
  } satisfies Partial<CSSStyleDeclaration>);
  num.textContent = value;
  const lbl = document.createElement("div");
  Object.assign(lbl.style, {
    fontSize: "10px",
    letterSpacing: "0.12em",
    color: "var(--faint)",
    marginTop: "4px",
  } satisfies Partial<CSSStyleDeclaration>);
  lbl.textContent = label;
  cell.append(num, lbl);
  return cell;
}

/** A roster agent-class card. `accent` is the class's signature color. */
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
    background: "rgba(30,41,59,0.5)",
    border: "1px solid var(--line-faint)",
    borderTop: `2px solid ${accent}`,
    borderRadius: "var(--radius-4)",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);

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
    color: "var(--muted)",
    flex: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  body.textContent = blurb;

  const cta = document.createElement("div");
  Object.assign(cta.style, {
    marginTop: "4px",
    fontSize: "10px",
    letterSpacing: "0.1em",
    color: accent,
  } satisfies Partial<CSSStyleDeclaration>);
  cta.textContent = "DEPLOY →";

  card.append(top, name, body, cta);
  card.addEventListener("click", deploy);
  return card;
}

/** A game-mode card with a deploy CTA. */
function modeCard(
  tag: string,
  title: string,
  blurb: string,
  deploy: () => void,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    background: "rgba(30,41,59,0.5)",
    border: "1px solid var(--line-faint)",
    borderRadius: "var(--radius-4)",
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
    color: "var(--muted)",
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
    border: "1px solid rgba(34,211,238,0.3)",
    borderRadius: "var(--radius-3)",
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
    background: "rgba(30,41,59,0.5)",
    border: "1px solid var(--line-faint)",
    borderRadius: "var(--radius-4)",
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
    color: "var(--muted)",
    marginTop: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  body.textContent = answer;

  details.append(summary, body);
  return details;
}

/** A HOW-IT-PLAYS / arsenal card (number-or-glyph, accent glyph, title, body). */
function howCard(
  num: string,
  glyph: string,
  title: string,
  glyphColor: string,
  body: string,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    background: "rgba(30,41,59,0.5)",
    border: "1px solid var(--line-faint)",
    borderRadius: "var(--radius-4)",
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  // All values are STATIC literals from the call site (no dynamic/user data).
  card.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">` +
    `<span style="font-family:var(--font-mono);color:var(--accent);font-size:15px">${num}</span>` +
    `<span style="font-size:18px;color:${glyphColor}">${glyph}</span></div>` +
    `<div style="font-family:var(--font-display);font-weight:700;font-size:15px;` +
    `color:var(--text);letter-spacing:0.04em">${title}</div>` +
    `<div style="font-size:11px;line-height:1.6;color:var(--muted)">${body}</div>`;
  return card;
}

/** A decorative corner bracket (the mockup HUD-frame motif). */
function cornerBracket(vert: "top" | "bottom", side: "left" | "right"): string {
  const v = vert === "top" ? "top:14px" : "bottom:14px";
  const h = side === "left" ? "left:14px" : "right:14px";
  const bv = vert === "top" ? "border-top" : "border-bottom";
  const bh = side === "left" ? "border-left" : "border-right";
  return (
    `<div style="position:absolute;${v};${h};width:26px;height:26px;` +
    `${bv}:2px solid var(--accent);${bh}:2px solid var(--accent)"></div>`
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
