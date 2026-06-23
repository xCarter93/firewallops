/*
 * motion.ts — tiny, framework-free motion helpers for the web-app shell (Phase 6
 * interactivity pass). The actual animation/transition rules live in shell.css as
 * a centralized "MOTION SYSTEM" block keyed off the existing `fw-*` class names;
 * this module only drives the JS-side bits CSS can't do alone:
 *
 *   - prefersReducedMotion()  — the media-query check, so callers can short-circuit.
 *   - revealOnScroll()        — adds `.fw-in` to elements as they scroll into view
 *                               (one-shot), so the landing's card grids cascade in
 *                               on first sight instead of all at once on mount.
 *
 * ACCESSIBILITY CONTRACT (UI-UX animation rule — High): every effect is guarded by
 * `prefers-reduced-motion: reduce`. The CSS block neutralizes motion globally under
 * that query; here, `revealOnScroll` reveals everything IMMEDIATELY (no observer)
 * so reduced-motion users — and any environment without IntersectionObserver
 * (jsdom) — never get stuck on the hidden pre-reveal state.
 */

/** True when the user has asked the OS to minimize non-essential motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Reveal `targets` on scroll: add the `.fw-in` class the first time each element
 * enters the viewport, then stop observing it. The shell.css `.fw-reveal-group`
 * rules keep a group's children hidden until `.fw-in` lands, then cascade them in.
 *
 * Falls back to revealing everything synchronously when motion is reduced or
 * IntersectionObserver is unavailable, so content is never left invisible. Returns
 * a disposer that disconnects the observer (safe to ignore on the always-present
 * landing route).
 */
export function revealOnScroll(targets: Iterable<Element | null>): () => void {
  const els = Array.from(targets).filter(
    (e): e is Element => e !== null,
  );

  // Reduced motion / no-IO (jsdom): reveal now, observe nothing.
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
    for (const el of els) el.classList.add("fw-in");
    return () => {};
  }

  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("fw-in");
          obs.unobserve(entry.target); // one-shot — never animate back out.
        }
      }
    },
    // Fire a touch before fully in view so the cascade reads as you arrive.
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );

  for (const el of els) io.observe(el);
  return () => io.disconnect();
}
