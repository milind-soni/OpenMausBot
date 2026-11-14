export interface Membership {
  authority: "local" | "portal";
  pairingCodes: boolean;
  peopleUrl: string | null;
}

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
