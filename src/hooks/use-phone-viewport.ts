import { useLayoutEffect } from "react";

export function usePhoneViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.getElementById("root");
    if (!root) return;
    const viewport = window.visualViewport;
    let frame = 0;
    root.dataset.phoneViewport = "";

    const sync = () => {
      if (viewport && viewport.height > 0 && Math.abs(viewport.scale - 1) <= 0.01) {
        root.style.setProperty("--phone-height", `${viewport.height}px`);
        root.style.setProperty("--phone-top", `${Math.max(0, viewport.offsetTop)}px`);
        root.toggleAttribute("data-phone-keyboard", viewport.height < window.innerHeight - 1);
      } else {
        root.style.removeProperty("--phone-height");
        root.style.removeProperty("--phone-top");
        delete root.dataset.phoneKeyboard;
      }
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
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pageshow", schedule);
      delete root.dataset.phoneViewport;
      root.style.removeProperty("--phone-height");
      root.style.removeProperty("--phone-top");
      delete root.dataset.phoneKeyboard;
    };
  }, [enabled]);
}
