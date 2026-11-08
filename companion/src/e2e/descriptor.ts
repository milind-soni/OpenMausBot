// The `e2e` pairing descriptor: in the QR link's `e2e` parameter, in the pair response and in the endpoint list.
// Wire spec: companion/src/e2e/README.md, "Pairing payload and descriptors".
import { b64u, fromB64u, HOST_ID_BYTES } from "./credentials.ts";
import { isPublicKey, PUBLIC_KEY_BYTES } from "./noise.ts";

export const DESCRIPTOR_VERSION = 1;
export const MAX_DESCRIPTOR_CHARS = 1024;
export const MAX_RELAY_NODES = 4;
export const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;

export type DescriptorRoutes = "any" | "local";

export interface E2EDescriptor {
  v: 1;
  /** b64u of the 65-byte transport key `T.pub` */
  k: string;
  /** b64u of the 16-byte hostId; present only with `r` */
  h?: string;
  /** relay hostnames in the order to try */
  r?: string[];
  /** "local": the computer restricted this device to Wi-Fi and Tailscale. It may still carry `h` and `r`, so a phone away
   * from home can probe the relay now and then and learn when it is allowed again; the relay refuses it (4404) until
   * then. Absent means "any"; then a missing relay only means the computer has none (signed out, or outside the rollout). */
  routes?: DescriptorRoutes;
}

export function encodeDescriptor(descriptor: E2EDescriptor): string {
  const relay = descriptor.h && descriptor.r ? { h: descriptor.h, r: descriptor.r } : {};
  const json = JSON.stringify({ v: 1, k: descriptor.k, ...relay, ...(descriptor.routes ? { routes: descriptor.routes } : {}) });
  return b64u(Buffer.from(json, "utf8"));
}

/** A restricted device's descriptor says so; it keeps the relay identity, which admits nothing by itself. */
export function descriptorFor(
  transportPublicKey: Uint8Array,
  relay?: { hostId: Uint8Array; nodes: readonly string[] },
  routes?: DescriptorRoutes,
): E2EDescriptor {
  const base = relay && relay.nodes.length > 0
    ? { v: 1 as const, k: b64u(transportPublicKey), h: b64u(relay.hostId), r: [...relay.nodes] }
    : { v: 1 as const, k: b64u(transportPublicKey) };
  return routes === "local" ? { ...base, routes: "local" } : base;
}

/** `update` means a newer version: the phone says "Update the MausBot app" and never falls back to plain pairing.
 * `reject` refuses the whole invite. */
export type DescriptorParse =
  | { outcome: "ok"; descriptor: E2EDescriptor; transportKey: Buffer; hostId: Buffer | null }
  | { outcome: "update" }
  | { outcome: "reject"; reason: string };

/** Accepts either the b64u text (the QR parameter) or the already-decoded object (a JSON response field). */
export function parseDescriptor(input: unknown): DescriptorParse {
  const reject = (reason: string): DescriptorParse => ({ outcome: "reject", reason });
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_DESCRIPTOR_CHARS) return reject("too_long");
    const bytes = fromB64u(input);
    if (!bytes) return reject("base64");
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return reject("json");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("json");
  const fields = value as Record<string, unknown>;
  if (!Number.isSafeInteger(fields.v) || (fields.v as number) < 1) return reject("version");
  if ((fields.v as number) > DESCRIPTOR_VERSION) return { outcome: "update" };
  const transportKey = typeof fields.k === "string" ? fromB64u(fields.k) : null;
  if (!transportKey || transportKey.length !== PUBLIC_KEY_BYTES || !isPublicKey(transportKey)) return reject("key");
  const hasHost = fields.h !== undefined;
  const hasRelays = fields.r !== undefined;
  if (hasHost !== hasRelays) return reject("relay_pair");
  if (fields.routes !== undefined && fields.routes !== "any" && fields.routes !== "local") return reject("routes");
  const routes = fields.routes === undefined ? {} : { routes: fields.routes as DescriptorRoutes };
  if (!hasHost) return { outcome: "ok", descriptor: { v: 1, k: fields.k as string, ...routes }, transportKey, hostId: null };
  const hostId = typeof fields.h === "string" ? fromB64u(fields.h) : null;
  if (!hostId || hostId.length !== HOST_ID_BYTES) return reject("host_id");
  const relays = fields.r;
  if (!Array.isArray(relays) || relays.length < 1 || relays.length > MAX_RELAY_NODES) return reject("relays");
  if (!relays.every((host): host is string => typeof host === "string" && RELAY_HOST.test(host))) return reject("relay_host");
  return { outcome: "ok", descriptor: { v: 1, k: fields.k as string, h: fields.h as string, r: [...relays], ...routes }, transportKey, hostId };
}
