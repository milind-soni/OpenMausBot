// One way to change onboarding state with a View Transition: the browser
// snapshots the old frame, the update is flushed synchronously, and named
// elements (`view-transition-name`) morph while the rest cross-fades. Falls
// back to a plain update under reduced motion or without the API, so callers
// never branch on support.
import { flushSync } from "react-dom";
import { reducedMotion } from "@/lib/onboarding";

export function withViewTransition(update: () => void): void {
  if (reducedMotion() || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
