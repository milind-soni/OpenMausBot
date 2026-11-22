import { useEffect, useState } from "react";
import { nativeViewOverlayIntersects } from "@/lib/local-vm-workspace";

const NATIVE_VIEW_OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  "[popover]",
  "[data-native-view-overlay]",
  ".fixed",
  ".absolute",
].join(",");

/** Rendered at all: a closed <details>' content, display:none, visibility:hidden or opacity 0 is not. */
function rendered(candidate: HTMLElement, style: CSSStyleDeclaration): boolean {
  const closed = candidate.closest("details:not([open])");
  if (closed && !candidate.closest("summary")?.parentElement?.isSameNode(closed)) return false;
  if (typeof candidate.checkVisibility === "function") return candidate.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

/**
 * Whether `candidate` paints above the native view's host where their rectangles meet: the topmost element at a few
 * points of the overlap is the candidate or inside it. A sidebar under a maximised panel meets its rectangle but paints
 * below it. Undefined where the page cannot hit-test there: no point answered (off screen or without layout), or the
 * candidate takes no pointer events, which hit-testing passes through though it paints.
 */
function paintsAbove(candidate: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect, hosts: readonly DOMRect[]): boolean | undefined {
  if (typeof document.elementFromPoint !== "function" || style.pointerEvents === "none") return undefined;
  let tested = false;
  for (const host of hosts) {
    const left = Math.max(rect.left, host.left);
    const right = Math.min(rect.right, host.right);
    const top = Math.max(rect.top, host.top);
    const bottom = Math.min(rect.bottom, host.bottom);
    if (left >= right || top >= bottom) continue;
    const inset = (from: number, to: number, at: number) => from + Math.min(Math.max(1, (to - from) * at), to - from - 0.5);
    const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => [inset(left, right, x!), inset(top, bottom, y!)] as const);
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      tested = true;
      if (hit === candidate || candidate.contains(hit)) return true;
    }
  }
  return tested ? false : undefined;
}

/**
 * Electron's native views always paint above the renderer, so an overlay or popover that paints above the view's host
 * where they meet counts, portals included.
 */
function rendererOverlayIntersectsNativeView() {
  const hosts = [...document.querySelectorAll<HTMLElement>("[data-native-view-host]")];
  const hostRects = hosts
    .map((host) => host.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (hostRects.length === 0) return false;

  const candidates = [...document.querySelectorAll<HTMLElement>(NATIVE_VIEW_OVERLAY_SELECTOR)]
    .filter(
      (candidate) =>
        !hosts.some(
          (host) => candidate === host || candidate.contains(host) || host.contains(candidate),
        ),
    )
    .map((candidate) => {
      const style = window.getComputedStyle(candidate);
      const explicitlyOverlay =
        candidate.matches(
          '[aria-modal="true"], [role="dialog"], [role="menu"], [popover], [data-native-view-overlay]',
        );
      const zIndex = Number.parseInt(style.zIndex, 10);
      const rect = candidate.getBoundingClientRect();
      const visible = rendered(candidate, style);
      const above = visible ? paintsAbove(candidate, style, rect, hostRects) : false;
      return {
        rect,
        explicit: explicitlyOverlay,
        visible,
        zIndex: Number.isFinite(zIndex) ? zIndex : null,
        ...(above === undefined ? {} : { above }),
      };
    });
  return nativeViewOverlayIntersects(hostRects, candidates);
}

/** `watching` false leaves the page unobserved, for a panel that shows no native view. */
export function useNativeViewObscured(explicit: boolean, watching = true) {
  const [domOverlay, setDomOverlay] = useState(false);
  useEffect(() => {
    if (!watching) {
      setDomOverlay(false);
      return;
    }
    let frame = 0;
    const read = () => setDomOverlay(rendererOverlayIntersectsNativeView());
    const scheduleRead = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    };
    read();
    const observer = new MutationObserver(scheduleRead);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "aria-modal", "role", "open", "popover"],
    });
    const resizeObserver = new ResizeObserver(scheduleRead);
    resizeObserver.observe(document.body);
    for (const host of document.querySelectorAll<HTMLElement>("[data-native-view-host]")) {
      resizeObserver.observe(host);
    }
    const overlayEvents = [
      "toggle",
      "animationstart",
      "animationend",
      "transitionstart",
      "transitionend",
    ] as const;
    for (const eventName of overlayEvents) {
      document.addEventListener(eventName, scheduleRead, true);
    }
    window.addEventListener("resize", scheduleRead);
    window.addEventListener("scroll", scheduleRead, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      for (const eventName of overlayEvents) {
        document.removeEventListener(eventName, scheduleRead, true);
      }
      window.removeEventListener("resize", scheduleRead);
      window.removeEventListener("scroll", scheduleRead, true);
    };
  }, [watching]);
  return explicit || domOverlay;
}
