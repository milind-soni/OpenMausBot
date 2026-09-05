/** The one shared-element transition on the canvas.
 *
 * A card lifts out of the grid into a full-screen surface. FLIP: measure where
 * the element starts, let it be laid out where it ends, then animate the
 * difference away. The Web Animations API is enough — no animation library.
 */

export interface FlipOptions {
  durationMs?: number;
  easing?: string;
}

const DEFAULT_DURATION = 320;
// A gentle overshoot-free ease; matches how macOS lifts a window.
const DEFAULT_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Animate `element` as though it had started at `from`. Returns a promise that
 * settles when the motion finishes — immediately under reduced motion, where
 * the transition becomes a cut.
 */
export function flipFrom(element: HTMLElement, from: DOMRect, options: FlipOptions = {}): Promise<void> {
  if (prefersReducedMotion() || typeof element.animate !== "function") return Promise.resolve();

  const to = element.getBoundingClientRect();
  if (to.width === 0 || to.height === 0 || from.width === 0 || from.height === 0) return Promise.resolve();

  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  // Already in place: nothing worth animating.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) {
    return Promise.resolve();
  }

  const animation = element.animate(
    [
      { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.6 },
      { transformOrigin: "top left", transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
    ],
    {
      duration: options.durationMs ?? DEFAULT_DURATION,
      easing: options.easing ?? DEFAULT_EASING,
      fill: "none",
    },
  );
  return animation.finished.then(() => undefined).catch(() => undefined);
}
