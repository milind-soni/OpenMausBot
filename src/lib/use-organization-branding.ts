import { useEffect, useState } from "react";
import type { ManagedDesktopState } from "../../electron/managed-desktop.mjs";
import { parseOrganizationBranding } from "../../electron/organization-branding.mjs";

/** Native enrollment only: never apply this computer's branding to a remote workspace. */
export function useOrganizationBranding() {
  // Rendered without a window in the server-rendered component tests, so the
  // bridge lookup has to tolerate its absence rather than throw at render.
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  const bridge = ogb?.remoteClient?.active ? undefined : ogb?.organization;
  const [state, setState] = useState<ManagedDesktopState | null>(null);
  useEffect(() => {
    let active = true, revision = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    setState(null);
    const receive = (next: ManagedDesktopState) => {
      if (!active) return;
      revision++;
      clearTimeout(expiry);
      setState(next);
      if (next.expiresAt && next.expiresAt > Date.now()) expiry = setTimeout(() => setState(null), Math.min(next.expiresAt - Date.now(), 2_147_483_647));
    };
    const unsubscribe = bridge?.onState(receive);
    const initial = revision;
    void bridge?.state().then(next => { if (revision === initial) receive(next); }).catch(() => {});
    return () => { active = false; clearTimeout(expiry); unsubscribe?.(); };
  }, [bridge]);
  if (!bridge || !state?.organization || !["connected", "unavailable"].includes(state.status) || !state.expiresAt || state.expiresAt <= Date.now()) return null;
  return { name: state.organization.name, ...parseOrganizationBranding(state.branding) };
}
