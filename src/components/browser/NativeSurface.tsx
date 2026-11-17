import { useLayoutEffect, useRef } from "react";

import type { PreviewStreamControl } from "@/lib/browser-stream-client";
import { nativeViewOverlayIntersects } from "@/lib/local-vm-workspace";

interface NativeSurfaceProps {
  readonly token: string | null;
  readonly control: PreviewStreamControl | null;
  readonly label?: string;
  readonly visible?: boolean;
  readonly onTake?: () => void;
  readonly onLeave?: () => void;
  readonly onActivity?: () => void;
}

function rendered(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true"
      || (node.tagName === "DIALOG" || node.tagName === "DETAILS") && !node.hasAttribute("open")) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
  }
  return true;
}

function obscured(element: HTMLElement): boolean {
  const overlays = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [popover]')]
    .filter((candidate) => candidate !== element && !candidate.contains(element) && !element.contains(candidate) && rendered(candidate));
  if (overlays.some((candidate) => candidate.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))) return true;
  return nativeViewOverlayIntersects([element.getBoundingClientRect()], overlays.map((candidate) => ({
    rect: candidate.getBoundingClientRect(), explicit: true, visible: true, zIndex: null,
  })));
}

export function NativeSurface(props: NativeSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const update = useRef(() => {});

  useLayoutEffect(() => {
    const element = host.current;
    const bridge = window.ogb?.nativeBrowser;
    const token = props.token;
    if (!element || !bridge || !token) return;
    let active = true;
    let queued = false;
    let shown = false;
    let intersecting = true;
    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    let lastLayout = "";

    const place = (hide = false) => {
      const control = latest.current.control;
      const visible = !hide && latest.current.token === token && latest.current.visible !== false && intersecting
        && document.visibilityState !== "hidden" && control?.controller !== "another-viewer"
        && bounds.width > 0 && bounds.height > 0 && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0
        && bounds.x < window.innerWidth && bounds.y < window.innerHeight
        && rendered(element) && !obscured(element);
      const next = { token, bounds, visible, canInput: visible && control?.canOperate === true && control.controller === "you" };
      shown = visible;
      const signature = JSON.stringify(next);
      if (signature === lastLayout) return;
      lastLayout = signature;
      void Promise.resolve(bridge.layout(next)).catch(() => {});
    };
    const hide = () => place(true);
    const measure = () => {
      if (!active) return;
      const rect = element.getBoundingClientRect();
      const next = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
      bounds = next;
      place();
    };
    const schedule = () => {
      if (queued || !active) return;
      queued = true;
      queueMicrotask(() => { queued = false; measure(); });
    };
    update.current = measure;
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const intersection = new IntersectionObserver((entries) => {
      if (!active) return;
      intersecting = entries[entries.length - 1]?.isIntersecting ?? false;
      measure();
    });
    intersection.observe(element);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "inert", "aria-hidden", "aria-modal", "role", "popover", "style", "class"] });
    const overlayEvents = ["toggle", "animationstart", "animationend", "transitionstart", "transitionend"] as const;
    for (const event of overlayEvents) document.addEventListener(event, schedule, true);
    document.addEventListener("visibilitychange", measure);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const unsubscribe = bridge.onTake((event) => {
      const control = latest.current.control;
      if (active && shown && latest.current.token === token && latest.current.visible !== false && event.token === token && control?.canOperate && control.controller !== "another-viewer") latest.current.onTake?.();
    });
    const unsubscribeFocus = bridge.onFocusAddress?.((event) => {
      if (active && shown && latest.current.token === token && latest.current.visible !== false && event.token === token) latest.current.onLeave?.();
    });
    const unsubscribeActivity = bridge.onActivity?.((event) => {
      const control = latest.current.control;
      if (active && shown && latest.current.token === token && latest.current.visible !== false && event.token === token && control?.canOperate && control.controller === "you") latest.current.onActivity?.();
    });
    measure();
    return () => {
      hide();
      active = false;
      update.current = () => {};
      unsubscribe();
      unsubscribeFocus?.();
      unsubscribeActivity?.();
      resize.disconnect();
      intersection.disconnect();
      mutation.disconnect();
      document.removeEventListener("visibilitychange", measure);
      for (const event of overlayEvents) document.removeEventListener(event, schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [props.token]);

  useLayoutEffect(() => { update.current(); }, [props.visible, props.control]);

  return <div ref={host} aria-label={props.label} className="size-full" />;
}
