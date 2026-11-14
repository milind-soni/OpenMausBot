import { useEffect, useState } from "react";
import { cloudOwnerOf } from "@/lib/session";
import { api } from "@/state/store";

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
