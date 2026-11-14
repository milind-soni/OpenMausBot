// Read before main.tsx's first-paint writes: applySkin stamps omb-skin on every boot.
const PRIOR_RUN_KEYS = ["omb-skin", "omb-installed", "omb-email-gate", "omb-drafts", "omb-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
