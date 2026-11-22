/** Frames a box must keep still before following it stops. */
const SETTLE_FRAMES = 3;
/** A transition or animation that never reports its end stops being followed after this long. */
const MAX_FOLLOW_MS = 5_000;

const STARTS = ["transitionrun", "transitionstart", "animationstart"] as const;
const ENDS = ["transitionend", "transitioncancel", "animationend", "animationcancel"] as const;

/**
 * Calls `moved` whenever `element`'s box changes: on resize, scroll, a page change, and on every frame while a
 * transition or animation runs anywhere on the page, since a sliding sidebar moves a box without resizing it. A native
 * view placed over the box follows it this way. Returns the function that stops following.
 */
export function followBounds(element: HTMLElement, moved: () => void): () => void {
  let frame = 0;
  let last = "";
  let still = 0;
  let running = 0;
  let runningUntil = 0;
  const box = () => {
    const rect = element.getBoundingClientRect();
    return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
  };
  const tick = () => {
    frame = 0;
    const now = box();
    if (now !== last) {
      last = now;
      still = 0;
      moved();
    } else {
      still += 1;
    }
    if (running > 0 && performance.now() > runningUntil) running = 0;
    if (running > 0 || still < SETTLE_FRAMES) frame = requestAnimationFrame(tick);
  };
  const watch = () => {
    still = 0;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const started = () => {
    running += 1;
    runningUntil = performance.now() + MAX_FOLLOW_MS;
    watch();
  };
  const ended = () => {
    running = Math.max(0, running - 1);
    watch();
  };
  last = box();
  const resizes = new ResizeObserver(watch);
  resizes.observe(element);
  resizes.observe(document.documentElement);
  const changes = new MutationObserver(watch);
  changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  for (const name of STARTS) document.addEventListener(name, started, true);
  for (const name of ENDS) document.addEventListener(name, ended, true);
  window.addEventListener("resize", watch);
  window.addEventListener("scroll", watch, true);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    resizes.disconnect();
    changes.disconnect();
    for (const name of STARTS) document.removeEventListener(name, started, true);
    for (const name of ENDS) document.removeEventListener(name, ended, true);
    window.removeEventListener("resize", watch);
    window.removeEventListener("scroll", watch, true);
  };
}
