import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

export function readColorScheme(element: Element | null = typeof document === "undefined" ? null : document.documentElement): ColorScheme {
  if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return "dark";
  try {
    return window.getComputedStyle(element).getPropertyValue("--code-color-scheme").trim() === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

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
