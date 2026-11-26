import { useLayoutEffect, type RefObject } from "react";

import { cn } from "@/lib/cn";

export const BOT_PANEL_ID = "bot-panel";

/** From md up the panel keeps its width while it slides in from the window's edge: `panel-beside-in` (styles.css)
 * grows the room it takes from nothing, so beside the chat the chat narrows with it instead of jumping, and nothing in
 * the panel rewraps on the way. */
export const sidePanelCls = (overlay: boolean, simple = false) => cn(
  "animate-sheet-in md:animate-panel-beside-in absolute inset-0 z-40 flex h-full min-w-0 flex-col outline-none focus-visible:outline-none! motion-reduce:animate-none",
  simple ? "[--side-panel-w:320px]" : "[--side-panel-w:min(420px,42vw)]",
  simple && !overlay ? "border-l-[0.5px] border-ink/[0.06] bg-app" : "border-l border-hairline/40 bg-panel",
  overlay
    ? "md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-(--side-panel-w) md:shadow-2xl"
    : "md:static md:z-auto md:w-(--side-panel-w) md:shrink-0",
);

const LEAVE_MS = 240;
const LEAVE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function reducedMotion(doc: Document): boolean {
  return doc.documentElement.dataset.reducedMotion === "true" || doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The panel is gone the moment it closes: focus has gone back and its keys are off. Beside the chat, an inert copy
 * of it is left in its place and slides back out over the window's edge, giving the chat its room back over the
 * same 240ms it took. A floating panel, reduced motion, or another panel taking this one's place (a different bot's,
 * or Computer) leaves no copy, or ends it. */
export function leaveSidePanel(panel: HTMLElement): void {
  const parent = panel.parentElement, doc = panel.ownerDocument;
  if (!parent || typeof panel.animate !== "function" || reducedMotion(doc)) return;
  const position = doc.defaultView?.getComputedStyle(panel).position;
  if (position && position !== "static") return;
  const width = panel.getBoundingClientRect().width;
  if (width <= 0) return;
  const before = new Set(parent.querySelectorAll(":scope > aside"));
  const next = panel.nextSibling;
  const copy = panel.cloneNode(true) as HTMLElement;
  // HTML ids go (no duplicates for labels or tests to find); SVG ones stay, since the copy's marks fill through them.
  for (const node of [copy, ...copy.querySelectorAll("[id]")]) if (!(node instanceof SVGElement)) node.removeAttribute("id");
  // A copy starts scrolled to the top: note where each scrolled part of the panel was, while it still has a layout.
  const from = [panel, ...panel.querySelectorAll<HTMLElement>("*")], to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  const scrolled = from.flatMap((node, index) => node.scrollTop ? [[to[index]!, node.scrollTop] as const] : []);
  for (const node of copy.querySelectorAll("iframe, video, audio")) node.remove();
  for (const name of ["role", "aria-labelledby", "aria-modal", "tabindex"]) copy.removeAttribute(name);
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.dataset.sidePanelLeaving = "";
  Object.assign(copy.style, { animation: "none", pointerEvents: "none" });
  // After the commit that removed it: by then a panel that replaces it has been placed.
  queueMicrotask(() => {
    if (panel.isConnected || !parent.isConnected) return;
    if ([...parent.querySelectorAll(":scope > aside")].some((node) => !before.has(node))) return;
    parent.insertBefore(copy, next?.parentNode === parent ? next : null);
    for (const [node, top] of scrolled) node.scrollTop = top;
    const motion = copy.animate(
      [{ marginInlineEnd: "0px", opacity: 1 }, { marginInlineEnd: `${-width}px`, opacity: 0 }],
      { duration: LEAVE_MS, easing: LEAVE_EASE, fill: "forwards" },
    );
    // A panel that arrives a little later (one that loads first, like Computer) takes the room at once.
    let arrivals: MutationObserver | null = null;
    const done = () => { arrivals?.disconnect(); copy.remove(); };
    if (typeof MutationObserver === "function") {
      arrivals = new MutationObserver((changes) => {
        if (changes.some((change) => [...change.addedNodes].some((node) => node instanceof HTMLElement && node.tagName === "ASIDE"))) done();
      });
      arrivals.observe(parent, { childList: true });
    }
    motion.finished.then(done, done);
  });
}

/** Leaves the panel's sliding copy behind when the panel unmounts (`leaveSidePanel`). */
export function useSidePanelLeave(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const panel = ref.current;
    return () => { if (panel) leaveSidePanel(panel); };
  }, [ref]);
}
