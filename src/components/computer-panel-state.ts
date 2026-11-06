import { z } from "zod";
import { parseComputerHelp } from "@/lib/computer-control";

export interface VpsComputerStatus {
  configured: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

export type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "busy-boat"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "team-boat"
  | "show-ready-boat"
  | "show-sleeping-boat"
  | "show-pending-boat"
  | "cloud-new"
  | "cloud-asleep"
  | "browser"
  | "off"
  | "error";

export interface ManagedLocalVmStatus extends LocalVmStatus {
  source: "managed";
}
export interface LocalVmStatus {
  resumable?: boolean;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
  target_key: string;
}

export interface ExistingLocalVmStatus {
  source: "existing";
  configured: boolean;
  sshAlias: string | null;
  ssh: "not-configured" | "connected" | "unreachable";
  os: "unknown" | "linux" | "unsupported";
  driver: "unknown" | "compatible" | "missing" | "incompatible";
  mcp: "unknown" | "ready" | "failed";
  tools: string[];
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  errorCode: string | null;
  driver_version: string;
  viewer_url: "";
  watch_only: true;
}

export type LocalVmUiStatus = ManagedLocalVmStatus | ExistingLocalVmStatus;

export const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
  help: z.unknown().optional().transform(parseComputerHelp),
  owned: z.boolean().optional(),
}).passthrough();
