import { useLayoutEffect, useState, type RefObject } from "react";
import {
  aspectFitNativeViewBounds,
  nativeViewOverlayIntersects,
} from "@/lib/local-vm-workspace";

const EXPLICIT_OVERLAY_SELECTOR =
  '[aria-modal="true"], [role="dialog"], [role="menu"], [popover], [data-native-view-overlay]';
// Responsive utility variants such as `max-md:absolute` do not match
// `.absolute`; a class substring gives us a bounded candidate set, and the
// computed position/z-index below decides whether it is currently raised.
const POSITIONED_OVERLAY_SELECTOR =
  `${EXPLICIT_OVERLAY_SELECTOR}, [class*="fixed"], [class*="absolute"]`;

function isOverlayCandidate(target: EventTarget | null): target is Element {
  return target instanceof Element && Boolean(target.closest(POSITIONED_OVERLAY_SELECTOR));
}

export function syncNativeViewResizeTargets<T>(
  observer: { observe(target: T): void; unobserve(target: T): void },
  observedTargets: Set<T>,
  nextTargets: Iterable<T>,
): void {
  const next = new Set(nextTargets);

  for (const target of observedTargets) {
    if (next.has(target)) continue;
    observer.unobserve(target);
    observedTargets.delete(target);
  }

  for (const target of next) {
    if (observedTargets.has(target)) continue;
    observer.observe(target);
    observedTargets.add(target);
  }
}

/**
 * Electron native views always paint above React. Hide a native view while a
 * renderer-owned dialog, menu, banner, or other raised layer crosses it so
 * controls never disappear behind the page.
 */
export function useNativeViewObscured(
  hostRef: RefObject<HTMLElement | null>,
  aspectRatio: number | null = null,
): boolean {
  const [obscured, setObscured] = useState(false);

  useLayoutEffect(() => {
    let frame = 0;
    let activeMotion = 0;
    let motionDeadline = 0;
    let resize: ResizeObserver | null = null;
    const resizeTargets = new Set<Element>();

    const read = () => {
      frame = 0;
      const host = hostRef.current;
      if (!host) {
        if (resize) {
          syncNativeViewResizeTargets(resize, resizeTargets, [document.body]);
        }
        setObscured(false);
      } else {
        const rawHostRect = host.getBoundingClientRect();
        const fittedHost = aspectRatio
          ? aspectFitNativeViewBounds({
              x: Math.round(rawHostRect.left),
              y: Math.round(rawHostRect.top),
              width: Math.round(rawHostRect.width),
              height: Math.round(rawHostRect.height),
            }, aspectRatio)
          : null;
        const hostRect = fittedHost
          ? {
              left: fittedHost.x,
              right: fittedHost.x + fittedHost.width,
              top: fittedHost.y,
              bottom: fittedHost.y + fittedHost.height,
              width: fittedHost.width,
              height: fittedHost.height,
            }
          : rawHostRect;
        const candidateElements = [
          ...document.querySelectorAll<HTMLElement>(POSITIONED_OVERLAY_SELECTOR),
        ].filter(
          (candidate) =>
            candidate !== host &&
            !candidate.contains(host) &&
            !host.contains(candidate),
        );
        if (resize) {
          syncNativeViewResizeTargets(resize, resizeTargets, [
            document.body,
            host,
            ...candidateElements,
          ]);
        }
        const candidates = candidateElements.map((candidate) => {
          const style = window.getComputedStyle(candidate);
          const zIndex = Number.parseInt(style.zIndex, 10);
          return {
            rect: candidate.getBoundingClientRect(),
            explicit: candidate.matches(EXPLICIT_OVERLAY_SELECTOR),
            visible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity) !== 0,
            zIndex: Number.isFinite(zIndex) ? zIndex : null,
          };
        });
        setObscured(
          nativeViewOverlayIntersects(
            hostRect.width > 0 && hostRect.height > 0 ? [hostRect] : [],
            candidates,
          ),
        );
      }
      // ResizeObserver and DOM mutations do not report intermediate animation
      // frames. Follow raised layers until their motion ends so a sliding
      // dialog cannot cross a live native page for a few frames.
      if (activeMotion > 0 && performance.now() < motionDeadline) {
        frame = window.requestAnimationFrame(read);
      } else if (activeMotion > 0) {
        // A removed animated node may never dispatch its matching end event.
        // Stop the safety sampling eventually instead of leaking a forever-rAF.
        activeMotion = 0;
      }
    };

    const scheduleRead = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    const startMotion = (event: Event) => {
      if (!isOverlayCandidate(event.target)) return;
      activeMotion += 1;
      motionDeadline = Math.max(motionDeadline, performance.now() + 30_000);
      scheduleRead();
    };
    const stopMotion = (event: Event) => {
      if (!isOverlayCandidate(event.target)) return;
      activeMotion = Math.max(0, activeMotion - 1);
      scheduleRead();
    };

    const mutation = new MutationObserver(scheduleRead);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "open",
        "hidden",
        "aria-hidden",
        "aria-modal",
        "role",
        "popover",
      ],
    });
    resize = new ResizeObserver(scheduleRead);
    read();

    for (const name of ["animationstart", "transitionstart"] as const) {
      document.addEventListener(name, startMotion, true);
    }
    for (const name of ["animationend", "animationcancel", "transitionend", "transitioncancel"] as const) {
      document.addEventListener(name, stopMotion, true);
    }
    document.addEventListener("toggle", scheduleRead, true);
    window.addEventListener("resize", scheduleRead);
    window.addEventListener("scroll", scheduleRead, true);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutation.disconnect();
      resize?.disconnect();
      resizeTargets.clear();
      for (const name of ["animationstart", "transitionstart"] as const) {
        document.removeEventListener(name, startMotion, true);
      }
      for (const name of ["animationend", "animationcancel", "transitionend", "transitioncancel"] as const) {
        document.removeEventListener(name, stopMotion, true);
      }
      document.removeEventListener("toggle", scheduleRead, true);
      window.removeEventListener("resize", scheduleRead);
      window.removeEventListener("scroll", scheduleRead, true);
    };
  }, [aspectRatio, hostRef]);

  return obscured;
}
