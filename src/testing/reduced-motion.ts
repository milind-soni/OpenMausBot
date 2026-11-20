import { afterEach, beforeEach } from "vitest";

export function useReducedMotionForTests() {
  let previous: string | undefined;
  beforeEach(() => {
    previous = document.documentElement.dataset.reducedMotion;
    document.documentElement.dataset.reducedMotion = "true";
  });
  afterEach(() => {
    if (previous === undefined) delete document.documentElement.dataset.reducedMotion;
    else document.documentElement.dataset.reducedMotion = previous;
  });
}
