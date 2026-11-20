import { useLayoutEffect } from "react";

export function usePhoneViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.getElementById("root");
    if (!root) return;
    const viewport = window.visualViewport;
    let frame = 0;
    let editing = false;
    let adjusted = false;
    root.dataset.phoneViewport = "";

    const sync = () => {
      const field = document.activeElement;
      const focused = field instanceof HTMLElement && field.matches("textarea, input, [contenteditable=true]");
      const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.01;
      const reduced = viewport && viewport.height > 0 && viewport.height < window.innerHeight - 1;
      if (focused && viewport && reduced && !zoomed) {
        root.style.setProperty("--phone-height", `${viewport.height}px`);
        root.style.setProperty("--phone-top", `${Math.max(0, viewport.offsetTop)}px`);
        root.dataset.phoneKeyboard = "";
        adjusted = true;
      } else {
        root.style.removeProperty("--phone-height");
        root.style.removeProperty("--phone-top");
        delete root.dataset.phoneKeyboard;
        if (!zoomed && (adjusted || (editing && !focused)) && window.scrollY) {
          window.scrollTo(0, 0);
        }
        adjusted = false;
      }
      editing = focused;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };
    sync();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("pageshow", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pageshow", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      delete root.dataset.phoneViewport;
      root.style.removeProperty("--phone-height");
      root.style.removeProperty("--phone-top");
      delete root.dataset.phoneKeyboard;
    };
  }, [enabled]);
}
