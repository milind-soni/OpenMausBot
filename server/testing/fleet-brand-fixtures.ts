import { emptyRegistry, type FleetRegistry, type FleetWorkspace } from "../fleet.ts";
import type { FleetReseller } from "../fleet-reseller.ts";

const bytes = (...parts: (number[] | string)[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)));

export const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "fixture-png-body");
export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "fixture-jpeg-body");
export const GIF = bytes("GIF89a", "fixture-gif-body");
export const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 fixture-webp-body");
export const ICO = bytes([0, 0, 1, 0, 1, 0], "fixture-ico-body");
export const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#c2510a"/></svg>');
export const HTML_NAMED_PNG = bytes("<!doctype html><html><body><script>alert(1)</script></body></html>");

export const RESELLER: FleetReseller = {
  name: "Acme Chat",
  currency: "USD",
  wholesale: { workspaceMonthMinor: 0, userMonthMinor: 0 },
  retail: { workspaceMonthMinor: 0, userMonthMinor: 0 },
};

export function workspace(slug: string, status: FleetWorkspace["status"] = "running", index = 0): FleetWorkspace {
  return { slug, host: `${slug}.agentada.cc`, port: 8810 + index * 10, webhookPort: 8811 + index * 10, status, createdAt: "2026-09-01T00:00:00.000Z" };
}

export function resellerRegistry(workspaces: FleetWorkspace[] = [], reseller: FleetReseller = RESELLER): FleetRegistry {
  return { ...emptyRegistry("agentada.cc"), reseller, workspaces: Object.fromEntries(workspaces.map((entry) => [entry.slug, entry])) };
}

export const dataUri = (mime: string, body: Uint8Array) => `data:${mime};base64,${Buffer.from(body).toString("base64")}`;
