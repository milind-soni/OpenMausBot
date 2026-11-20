import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { companionBridge } from "@/lib/companion-bridge";
import { readMembership } from "@/lib/membership";
import { isOwnerOrAdmin } from "@/lib/session";
import { readSharedSessionState } from "@/lib/shared-session";
import { useSidebarPhoneStatus } from "../SidebarPhoneButton";

export type PhonePlaceState =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "paired"; count: number; connected: boolean }
  | { kind: "attention"; count: number }
  | { kind: "managed"; organization: string }
  | { kind: "chat-only" }
  | { kind: "portal" };

let lookup: Promise<PhonePlaceState> | null = null;

/** What the server says of its paired phones. The nav and the page ask as they mount: both get the one lookup under way. */
function serverPhoneState(): Promise<PhonePlaceState> {
  if (lookup) return lookup;
  const asked: Promise<PhonePlaceState> = readSharedSessionState().then(async (session): Promise<PhonePlaceState> => {
    const config: unknown = await api("/api/config").catch(() => null);
    const codes = readMembership(config).pairingCodes;
    if (!isOwnerOrAdmin(session) && !(session.kind === "session" && session.team)) return { kind: codes ? "chat-only" : "portal" };
    if (!codes) return { kind: "portal" };
    const body = await api("/api/auth/sessions").catch(() => null) as { sessions?: unknown[]; current?: string } | null;
    const count = Array.isArray(body?.sessions) ? body.sessions.length - (body?.current ? 1 : 0) : 0;
    return count > 0 ? { kind: "paired", count, connected: false } : { kind: "none" };
  }).catch((): PhonePlaceState => ({ kind: "none" })).finally(() => { if (lookup === asked) lookup = null; });
  lookup = asked;
  return asked;
}

/** Phones paired with the place on screen, as the outer menu and the nav say it in a few words. */
export function usePhonePlaceState(enabled = true): PhonePlaceState {
  const policy = useStoreSelector((state) => state.config?.managedPolicy);
  const here = companionBridge() !== null && window.ogb?.remoteClient?.active !== true;
  const local = useSidebarPhoneStatus();
  const [server, setServer] = useState<PhonePlaceState>({ kind: "checking" });
  useEffect(() => {
    if (here || !enabled) return;
    let alive = true;
    void serverPhoneState().then((next) => { if (alive) setServer(next); });
    return () => { alive = false; };
  }, [here, enabled]);
  if (policy?.remoteAccess === false) return { kind: "managed", organization: policy.organizationName };
  if (!here) return server;
  if (local.kind === "checking") return { kind: "checking" };
  if (local.pairedCount === 0) return { kind: "none" };
  return { kind: "paired", count: local.pairedCount, connected: local.kind === "connected" || local.kind === "recent" };
}
