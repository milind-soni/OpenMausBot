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
  /** The person turned Tailscale on for the phone link; off, nothing runs the Tailscale CLI. Absent on older builds. */
  tailscaleOn?: boolean;
  /** The tailnet HTTPS address `tailscale serve` answers on while Tailscale is on. */
  tailnetHttps?: string;
  tailscaleProblem?: "not-found" | "port-taken" | "serve-refused";
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
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  /** Turns Tailscale on (starting the phone link if needed) and checks it. */
  refreshTailscale: () => Promise<CompanionState>;
  /** Absent on an app build before the Tailscale switch. */
  setTailscale?: (on: boolean) => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  browserControl: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
  /** Absent on an app build before the encrypted connection. */
  renewPairing?: () => Promise<CompanionState>;
  routes?: (deviceId: string, routes: "any" | "local") => Promise<CompanionState>;
};
