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

/**
 * Electron's native views always paint above the renderer, so any intersecting overlay or popover counts, portals
 * included.
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
      return {
        rect: candidate.getBoundingClientRect(),
        explicit: explicitlyOverlay,
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0,
        zIndex: Number.isFinite(zIndex) ? zIndex : null,
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
