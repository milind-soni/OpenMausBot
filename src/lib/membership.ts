// Who decides who may use this workspace, as GET /api/config reports it
// (server/enterprise.ts workspaceMembership). Settings → People and Remote
// access read it to stop offering controls the server would ignore or refuse.

/** Who decides who may use the workspace (GET /api/config `membership`). */
export interface Membership {
  authority: "local" | "portal";
  /** False on a hosted workspace: sign-in goes through the portal. */
  pairingCodes: boolean;
  /** Admin → People for this workspace; https only. */
  peopleUrl: string | null;
}

/** Read the server's answer defensively: an older server has no field and
 * means "this list decides", which is what it always meant there. */
export function readMembership(config: unknown): Membership {
  const raw = config && typeof config === "object" ? (config as { membership?: unknown }).membership : undefined;
  const value = raw && typeof raw === "object" ? raw as { authority?: unknown; pairingCodes?: unknown; peopleUrl?: unknown } : {};
  let peopleUrl: string | null = null;
  if (typeof value.peopleUrl === "string") {
    try {
      if (new URL(value.peopleUrl).protocol === "https:") peopleUrl = value.peopleUrl;
    } catch {
      peopleUrl = null;
    }
  }
  return { authority: value.authority === "portal" ? "portal" : "local", pairingCodes: value.pairingCodes !== false, peopleUrl };
}
