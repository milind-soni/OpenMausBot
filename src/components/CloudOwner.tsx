import { useEffect, useState } from "react";
import { cloudOwnerOf } from "@/lib/session";
import { api } from "@/state/store";

/** Whose OMB Cloud this browser is signed in to, for the sidebar's
 * "My Cloud · always on". Only a browser sign-in on a Cloud home has one
 * (docs/cloud-pro.md); anywhere else, and until it is known, null. */
export function useCloudOwner(cloudHome: boolean): string | null {
  const [owner, setOwner] = useState<string | null>(null);
  useEffect(() => {
    if (!cloudHome) return;
    let active = true;
    void api("/api/auth/session").then((session) => { if (active) setOwner(cloudOwnerOf(session)); }).catch(() => {});
    return () => { active = false; };
  }, [cloudHome]);
  return cloudHome ? owner : null;
}
