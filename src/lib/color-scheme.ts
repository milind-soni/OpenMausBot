import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

/** Which way the active skin leans, read from its --code-color-scheme token
 * (the same token the code blocks and Mermaid diagrams read). The skins are
 * pure CSS, so this is the one place a skin says whether it is light or dark;
 * nothing unreadable falls back to dark, the default skin's value. */
export function readColorScheme(element: Element | null = typeof document === "undefined" ? null : document.documentElement): ColorScheme {
  if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return "dark";
  try {
    return window.getComputedStyle(element).getPropertyValue("--code-color-scheme").trim() === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The scheme, following skin changes (the picker stamps data-skin on the
 * document element). */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => readColorScheme());
  useEffect(() => {
    const update = () => setScheme(readColorScheme());
    update();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, []);
  return scheme;
}
