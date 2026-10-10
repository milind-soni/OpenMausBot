// What this person may buy from OpenMausBot Cloud (electron/cloud-account.mjs
// offer): the session's own offer when signed in, the public plans otherwise.
import { useEffect, useState } from "react";
import type { CloudOffer } from "../../electron/cloud-home.mjs";

/** Asked only while an offer to buy is shown (`enabled`), and again when the
 * session's offer changes (`session`, the account state's `offer`); null when
 * nothing can be said, or this page has no bridge. */
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
