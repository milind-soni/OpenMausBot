import { useEffect, useState } from "react";
import type { CloudOffer } from "../../electron/cloud-home.mjs";

export function useCloudOffer(enabled: boolean, session?: CloudOffer): CloudOffer | null {
  const bridge = enabled && !window.ogb?.remoteClient?.active ? window.ogb?.cloudAccount : undefined;
  const [offer, setOffer] = useState<CloudOffer | null>(null);
  const key = bridge?.offer ? JSON.stringify(session ?? null) : null;
  useEffect(() => {
    if (key === null || !bridge?.offer) return;
    let active = true;
    void bridge.offer().then(next => { if (active) setOffer(next); }, () => {});
    return () => { active = false; };
  }, [bridge, key]);
  return bridge?.offer ? offer : null;
}
