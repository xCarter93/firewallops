import { isSignedIn, openSignIn, RETURN_TO_KEY } from "../auth.js";

/**
 * Landing page (Design screen 02, UI-SPEC Screen Inventory #1) — the app entry /
 * gate (Phase 5, Plan 06). Translated faithfully from the founder's Claude Design
 * Landing 02: nav + hero (`BREACH THE FIREWALL` headline, `DEPLOY NOW` cyan-glow
 * CTA) + a HOW-IT-PLAYS strip. Exact copy from the UI-SPEC Copywriting Contract.
 *
 * SCOPE TRIM (UI-SPEC): the STORE/economy nav is OMITTED (economy is out of v0).
 * The nav shows the game/info items only; STORE is not rendered.
 *
 * Auth-gated CTAs (AUTH-01/02): `DEPLOY NOW` / `PLAY FREE` → if signed in,
 * `navigate("/lobby")`; else open the Clerk sign-in surface (after sign-in the
 * router consumes `fwops:returnTo` and lands the user on /lobby).
 */

/** Render the landing page into `root`. `navigate` is the router's pushState nav. */
export function renderLanding(
  root: HTMLElement,
  navigate: (path: string) => void,
): void {
  root.innerHTML = "";

  // The CTA action shared by DEPLOY NOW / PLAY FREE / SIGN IN: gate on a session.
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
  page.style.minHeight = "100%";
  page.style.position = "relative";
  page.style.overflow = "hidden";
  page.style.background = "var(--bg)";
  page.style.backgroundImage =
    "linear-gradient(rgba(34,211,238,0.035) 1px, transparent 1px), " +
    "linear-gradient(90deg, rgba(34,211,238,0.035) 1px, transparent 1px)";
  page.style.backgroundSize = "48px 48px";
  page.style.fontFamily = "var(--font-body)";

  // ---- ambient glows (decorative) ----
  page.appendChild(
    glow("-200px", "-120px", "760px", "rgba(34,211,238,0.16)", "right", "top"),
  );
  page.appendChild(
    glow("-260px", "-160px", "680px", "rgba(168,85,247,0.12)", "left", "bottom"),
  );

  // ---- NAV ----
  const nav = el("nav", "fw-landing-nav");
  Object.assign(nav.style, {
    position: "relative",
    height: "74px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 44px",
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
  navLinks.innerHTML = `<span style="color:var(--text)">GAME</span><span>RANKED</span><span>UPDATES</span>`;

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
  Object.assign(hero.style, {
    position: "relative",
    display: "flex",
    padding: "64px 44px 0",
    gap: "40px",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const heroLeft = el("div", "fw-hero-left");
  Object.assign(heroLeft.style, {
    width: "600px",
    maxWidth: "100%",
    paddingTop: "24px",
  } satisfies Partial<CSSStyleDeclaration>);

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
    marginBottom: "48px",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  const deployNow = el("button", "fw-btn-primary");
  deployNow.type = "button";
  deployNow.textContent = "DEPLOY NOW"; // exact copy — the primary focal CTA.
  deployNow.addEventListener("click", deploy);

  ctaRow.appendChild(deployNow);
  heroLeft.append(badge, h1, sub, ctaRow);
  hero.appendChild(heroLeft);

  // ---- HOW IT PLAYS strip ----
  const strip = el("section", "fw-howstrip");
  Object.assign(strip.style, {
    position: "relative",
    display: "flex",
    gap: "18px",
    padding: "48px 44px 36px",
    flexWrap: "wrap",
  } satisfies Partial<CSSStyleDeclaration>);

  strip.appendChild(
    howCard("01", "⊹", "CALIBRATE", "var(--accent)", "Set angle & power against live packet-wind. Every degree counts."),
  );
  strip.appendChild(
    howCard("02", "⟁", "FORK & FIRE", "var(--accent)", "Single Packet, Forked Exploit, or charge the Trojan finisher."),
  );
  strip.appendChild(
    howCard("03", "⊗", "BREACH", "var(--danger)", "Crater the terrain, drain their HP, claim the last node standing."),
  );

  const free = el("div", "fw-howstrip-free");
  Object.assign(free.style, {
    flex: "1",
    minWidth: "200px",
    background: "linear-gradient(135deg, rgba(34,211,238,0.14), rgba(168,85,247,0.1))",
    border: "1px solid rgba(34,211,238,0.3)",
    borderRadius: "var(--radius-4)",
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "8px",
  } satisfies Partial<CSSStyleDeclaration>);
  free.innerHTML =
    `<div style="font-family:var(--font-display);font-weight:800;font-size:15px;` +
    `color:var(--text);letter-spacing:0.04em">FREE TO PLAY</div>` +
    `<div style="font-size:11px;line-height:1.6;color:var(--text-2)">No download. ` +
    `Jump into a match in under 30 seconds.</div>` +
    `<div style="margin-top:6px;font-size:11px;letter-spacing:0.1em;color:var(--accent)">DEPLOY NOW →</div>`;
  free.style.cursor = "pointer";
  free.addEventListener("click", deploy);
  strip.appendChild(free);

  page.append(nav, hero, strip);
  root.appendChild(page);
}

/** A HOW-IT-PLAYS card (number, glyph, title, body). */
function howCard(
  num: string,
  glyph: string,
  title: string,
  glyphColor: string,
  body: string,
): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    flex: "1",
    minWidth: "200px",
    background: "rgba(30,41,59,0.5)",
    border: "1px solid var(--line-faint)",
    borderRadius: "var(--radius-4)",
    padding: "22px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  } satisfies Partial<CSSStyleDeclaration>);
  card.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">` +
    `<span style="font-family:var(--font-mono);color:var(--accent);font-size:13px">${num}</span>` +
    `<span style="font-size:18px;color:${glyphColor}">${glyph}</span></div>` +
    `<div style="font-family:var(--font-display);font-weight:700;font-size:15px;` +
    `color:var(--text);letter-spacing:0.04em">${title}</div>` +
    `<div style="font-size:11px;line-height:1.6;color:var(--muted)">${body}</div>`;
  return card;
}

/** A decorative radial glow positioned at a corner. */
function glow(
  top: string,
  side: string,
  size: string,
  color: string,
  sideName: "left" | "right",
  vertName: "top" | "bottom",
): HTMLElement {
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
  return g;
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
