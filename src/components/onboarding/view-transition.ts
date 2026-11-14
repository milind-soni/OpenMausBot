import { flushSync } from "react-dom";
import { reducedMotion } from "@/lib/onboarding";

export function withViewTransition(update: () => void): ViewTransition | null {
  if (reducedMotion() || typeof document.startViewTransition !== "function") {
    update();
    return null;
  }
  return document.startViewTransition(() => {
    flushSync(update);
  });
}
