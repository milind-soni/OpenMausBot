type Box = { getBoundingClientRect(): { top: number } };

/** Moves `scroller` alone so `target` sits at its top or centre. Element.scrollIntoView would also scroll every
 * overflow-hidden ancestor, sliding a dialog's frame and its header out of view. */
export function scrollWithin(
  scroller: Box & { scrollTop: number; clientHeight: number },
  target: Box & { offsetHeight?: number },
  block: "start" | "center" = "start",
  margin = 0,
): void {
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = Math.max(0, block === "center" ? top - (scroller.clientHeight - (target.offsetHeight ?? 0)) / 2 : top - margin);
}

export function scrollParent(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
