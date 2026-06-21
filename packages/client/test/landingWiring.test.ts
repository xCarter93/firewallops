// @vitest-environment jsdom
//
// landingWiring.test.ts — the concern-9 wiring anchor for the restyled landing
// (Phase 6, Plan 05). The landing was rebuilt to the Claude Design mockup with the
// full marketing set (roster / modes / arsenal / stats / FAQ / footer), made
// scrollable, and given a responsive pass. This suite proves the LOAD-BEARING
// invariants survived that restyle:
//
//   1. a primary CTA click routes through the existing auth-gated deploy() — when
//      signed IN it navigate("/lobby")s and never opens sign-in;
//   2. when signed OUT the same CTA opens the Clerk sign-in surface (openSignIn)
//      and stashes /lobby as the return-to, and does NOT navigate to /lobby;
//   3. renderLanding creates NO #game-container (the canvas-lifecycle invariant —
//      the landing is a shell page, Blocker 3 / Pitfall 5);
//   4. NO-HORIZONTAL-SCROLL guard (Pitfall 7): the page root sets overflow-x:hidden
//      AND the ambient glows live inside a clipped decoration layer (overflow:hidden)
//      so removing the page-level overflow:hidden cannot regress to a horizontal
//      scrollbar.
//
// auth.js is mocked exactly like shellSmoke.test.ts so importing landing.ts pulls no
// real Clerk. The suite is synchronous — no network, no Colyseus.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── auth: a settable signed-in flag + a vi.fn() openSignIn (mirror shellSmoke) ──
let signedIn = true;
const openSignIn = vi.fn();
vi.mock("../src/shell/auth.js", () => ({
  RETURN_TO_KEY: "fwops:returnTo",
  SERVER_HTTP_URL: "http://localhost:2567",
  isSignedIn: () => signedIn,
  requireAuth: () => signedIn,
  openSignIn,
  consumeReturnTo: () => null,
  onAuthChange: () => () => {},
  getToken: async () => "wiring-token",
  mountUserButton: vi.fn(),
  mountSignIn: vi.fn(),
  signOut: vi.fn(async () => {}),
  initAuth: async () => {},
}));

const RETURN_TO_KEY = "fwops:returnTo";

/** Find the hero DEPLOY NOW primary CTA button by class + text. */
function findPrimaryCta(root: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
  const cta = buttons.find(
    (b) =>
      b.classList.contains("fw-btn-primary") &&
      (b.textContent ?? "").includes("DEPLOY"),
  );
  if (!cta) throw new Error("primary DEPLOY CTA not found on the landing");
  return cta;
}

describe("landing wiring (concern 9)", () => {
  beforeEach(() => {
    signedIn = true;
    openSignIn.mockClear();
    try {
      sessionStorage.clear();
    } catch {
      /* jsdom always has sessionStorage; ignore */
    }
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("CTA → deploy() signed in: navigate('/lobby'), no openSignIn", async () => {
    const { renderLanding } = await import("../src/shell/pages/landing.js");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const navigate = vi.fn();

    signedIn = true;
    renderLanding(root, navigate);
    findPrimaryCta(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(navigate).toHaveBeenCalledWith("/lobby");
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it("CTA → deploy() signed out: openSignIn + return-to stashed, no navigate('/lobby')", async () => {
    const { renderLanding } = await import("../src/shell/pages/landing.js");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const navigate = vi.fn();

    signedIn = false;
    renderLanding(root, navigate);
    findPrimaryCta(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openSignIn).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith("/lobby");
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe("/lobby");
  });

  it("creates no #game-container (shell page, not the canvas)", async () => {
    const { renderLanding } = await import("../src/shell/pages/landing.js");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const navigate = vi.fn();

    renderLanding(root, navigate);

    expect(root.querySelector("#game-container")).toBeNull();
    expect(document.getElementById("game-container")).toBeNull();
  });

  it("no-horizontal-scroll guard: page overflow-x clipped + glows in a clipped layer", async () => {
    const { renderLanding } = await import("../src/shell/pages/landing.js");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const navigate = vi.fn();

    renderLanding(root, navigate);

    // The page root clips horizontal overflow.
    const page = root.querySelector<HTMLElement>(".fw-landing");
    expect(page).not.toBeNull();
    expect(page?.style.overflowX).toBe("hidden");

    // The ambient glows live inside a dedicated decoration layer whose own
    // overflow:hidden clips their negative offsets to the viewport (Pitfall 7).
    const decor = root.querySelector<HTMLElement>(".fw-landing-decor");
    expect(decor).not.toBeNull();
    expect(decor?.style.overflow).toBe("hidden");
    expect(decor?.style.pointerEvents).toBe("none");
    // The glow divs were appended into the clipped layer, not the page flow.
    expect((decor?.children.length ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
