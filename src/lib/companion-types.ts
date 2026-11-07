import type { PairingE2EDescriptor } from "../../shared/pairing-link";
import type { CompanionEndpoint } from "./companion-pairing";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
  /** Absent (older sidecars) means no browser access. */
  browserControlAccess?: boolean;
  /** "local": Wi-Fi and Tailscale only. Absent on older sidecars. */
  routes?: "any" | "local";
  /** Its first end-to-end session; a device without one is on the old, unencrypted connection. */
  e2eAt?: number;
  /** Its best live encrypted route right now. */
  route?: "wifi" | "tailscale" | "relay" | null;
}

/** Same Wi-Fi, Anywhere through MausBot, Tailscale, and the HTTPS address. */
export type CompanionRoute = "wifi" | "relay" | "tailscale" | "https";

export interface CompanionState {
  enabled: boolean;
  keepAwake: boolean;
  port: number;
  devices: PhoneDevice[];
  connectedDeviceIds?: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  /** Each way into this computer and whether the person turned it on. Absent on older builds. */
  routes?: Record<CompanionRoute, { on: boolean; since: number | null; name?: string | null }>;
  /** Routes the update kept on that the person has not been told about yet. */
  notices?: CompanionRoute[];
  /** Why Tailscale could not be turned on or checked just now. */
  tailscaleProblem?: "not-installed" | "signed-out";
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  secretPublicKey?: string;
  discovery?: { advertising: boolean; name: string };
  /** Windows has that network down as Public, where its firewall drops a phone's connection. */
  publicNetwork?: string;
  /** The end-to-end connection; absent or `enabled: false` until this computer serves it. */
  e2e?: { enabled: boolean; relay: "connected" | "connecting" | "off"; node: string | null; descriptor: PairingE2EDescriptor | null };
  error?: string;
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  /** Turns on `routes` (Same Wi-Fi and the relay when omitted) and starts the phone link. */
  start: (routes?: CompanionRoute[]) => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  /** Check again: asks Tailscale for this computer's name while its route is on; starts nothing. */
  refreshTailscale: () => Promise<CompanionState>;
  /** The rest are absent on an app build before per-route switches. */
  setTailscale?: (on: boolean) => Promise<CompanionState>;
  setRoute?: (route: CompanionRoute, on: boolean) => Promise<CompanionState>;
  dismissNotice?: (route: CompanionRoute) => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  browserControl: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
  /** Absent on an app build before the encrypted connection. */
  renewPairing?: () => Promise<CompanionState>;
  routes?: (deviceId: string, routes: "any" | "local") => Promise<CompanionState>;
};
