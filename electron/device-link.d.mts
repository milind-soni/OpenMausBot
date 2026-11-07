import type { ChromeDoor, createChromeDoor } from "./device-chrome.mjs";
import type { createDeviceEgress } from "./device-egress.mjs";

export declare function linkUrl(origin: string, path: string): string;
export declare function runDeviceLink(options: {
  url: string;
  headers?: Record<string, string>;
  egress?: Omit<NonNullable<Parameters<typeof createDeviceEgress>[0]>, "seenAs">;
  signal?: AbortSignal;
  WebSocket?: typeof globalThis.WebSocket;
  pingMs?: number;
  silentMs?: number;
  openMs?: number;
  lends?: () => { internet: boolean; chrome: boolean; mcp?: boolean };
  chrome?: NonNullable<Parameters<typeof createChromeDoor>[0]> | ChromeDoor;
  mcp?: { open(target: { name: unknown; port?: unknown; fingerprint?: unknown }): Promise<{ socket?: import("node:stream").Duplex; refused?: string; failed?: string }> };
  onOpen?: () => void;
  onStream?: (target: { host: string; port: number } | { chrome: true } | { mcp: { name: unknown; port?: unknown; fingerprint?: unknown } }, result: { socket?: import("node:stream").Duplex; refused?: string; failed?: string }) => void;
  traffic?: () => void;
  now?: () => number;
}): Promise<{ code: number; reason: string }>;
