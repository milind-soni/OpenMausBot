import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { companionBridge } from "@/lib/companion-bridge";
import { readMembership } from "@/lib/membership";
import { isOwnerOrAdmin, readSessionState } from "@/lib/session";
import { useSidebarPhoneStatus } from "../SidebarPhoneButton";

export type PhonePlaceState =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "paired"; count: number; connected: boolean }
  | { kind: "attention"; count: number }
  | { kind: "managed"; organization: string }
  | { kind: "chat-only" }
  | { kind: "portal" };

/** Phones paired with the place on screen, as the outer menu and the nav say it in a few words. */
export function usePhonePlaceState(enabled = true): PhonePlaceState {
  const { state } = useStore();
  const here = companionBridge() !== null && window.ogb?.remoteClient?.active !== true;
  const local = useSidebarPhoneStatus();
  const [server, setServer] = useState<PhonePlaceState>({ kind: "checking" });
  const policy = state.config?.managedPolicy;
  useEffect(() => {
    if (here || !enabled) return;
    let alive = true;
    void readSessionState().then(async (session) => {
      const config: unknown = await api("/api/config").catch(() => null);
      const codes = readMembership(config).pairingCodes;
      if (!isOwnerOrAdmin(session) && !(session.kind === "session" && session.team)) {
        if (alive) setServer({ kind: codes ? "chat-only" : "portal" });
        return;
      }
      if (!codes) { if (alive) setServer({ kind: "portal" }); return; }
      const body = await api("/api/auth/sessions").catch(() => null) as { sessions?: unknown[]; current?: string } | null;
      const count = Array.isArray(body?.sessions) ? body.sessions.length - (body?.current ? 1 : 0) : 0;
      if (alive) setServer(count > 0 ? { kind: "paired", count, connected: false } : { kind: "none" });
    }).catch(() => { if (alive) setServer({ kind: "none" }); });
    return () => { alive = false; };
  }, [here, enabled]);
  if (policy?.remoteAccess === false) return { kind: "managed", organization: policy.organizationName };
  if (!here) return server;
  if (local.kind === "checking") return { kind: "checking" };
  if (local.pairedCount === 0) return { kind: "none" };
  return { kind: "paired", count: local.pairedCount, connected: local.kind === "connected" || local.kind === "recent" };
}
