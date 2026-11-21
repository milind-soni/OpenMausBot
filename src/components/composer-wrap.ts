import { useLayoutEffect, useState, type RefObject } from "react";

/** Simple: anything that grows the pill past its one 44px row (a second line, a reply strip) rounds its corners in. */
export function useTallPill(shellRef: RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!on || !shell || typeof ResizeObserver === "undefined") return;
    const measure = () => setTall(shell.getBoundingClientRect().height > 44.5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellRef, on]);
  return tall;
}
