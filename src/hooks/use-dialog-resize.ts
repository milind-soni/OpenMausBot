import { useLayoutEffect, type RefObject } from "react";

export function useDialogResize(ref: RefObject<HTMLElement | null>, open = true) {
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog?.animate || typeof ResizeObserver === "undefined") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => ({ width: dialog.offsetWidth, height: dialog.offsetHeight });
    let target = measure();
    let animation: Animation | undefined;

    const resize = () => {
      const from = animation ? measure() : target;
      animation?.cancel();
      animation = undefined;
      target = measure();

      if (!from.width || !from.height || !target.width || !target.height ||
          (from.width === target.width && from.height === target.height) ||
          preference.matches || document.documentElement.dataset.reducedMotion === "true") return;

      const widthChanged = from.width !== target.width;
      const heightChanged = from.height !== target.height;
      const keyframe = ({ width, height }: typeof from) => ({
        width: widthChanged ? `${width}px` : undefined,
        height: heightChanged ? `${height}px` : undefined,
      });
      animation = dialog.animate([keyframe(from), keyframe(target)], {
        duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
      animation.onfinish = () => {
        animation = undefined;
        resize();
      };
    };

    const observer = new ResizeObserver(() => { if (!animation) resize(); });
    observer.observe(dialog, { box: "border-box" });
    const changes = new MutationObserver(() => { if (animation) resize(); });
    changes.observe(dialog, { subtree: true, childList: true, characterData: true });
    changes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduced-motion"] });
    const retarget = () => { if (animation) resize(); };
    preference.addEventListener("change", retarget);
    window.addEventListener("resize", retarget);
    return () => {
      observer.disconnect();
      changes.disconnect();
      preference.removeEventListener("change", retarget);
      window.removeEventListener("resize", retarget);
      animation?.cancel();
    };
  }, [ref, open]);
}
