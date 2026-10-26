import { useEffect, useState } from "react";

import { isOwnerOrAdmin, readSessionState } from "./session";

const RETRY_MS = 10_000;
let known: boolean | null = null;
let looking = false;
let retry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(allowed: boolean) => void>();

function lookUp(): void {
  retry = null;
  if (known !== null || looking || !listeners.size) return;
  looking = true;
  void readSessionState()
    .then((state) => state.kind === "unreachable" ? null : isOwnerOrAdmin(state), () => null)
    .then((allowed) => {
      looking = false;
      if (allowed !== null) known = allowed;
      for (const listener of listeners) listener(allowed ?? false);
      if (allowed === null && listeners.size) retry = setTimeout(lookUp, RETRY_MS);
    });
}

export function useOwnerOrAdmin(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(known ?? (retry ? false : null));
  useEffect(() => {
    listeners.add(setAllowed);
    if (known !== null) setAllowed(known);
    else if (retry) setAllowed(false);
    else lookUp();
    return () => {
      listeners.delete(setAllowed);
    };
  }, []);
  return allowed;
}
