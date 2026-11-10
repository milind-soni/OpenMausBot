// What turns end-to-end on: the transport key, and the relay identity once the computer holds a relay token. The
// desktop app sends both over its private port; a standalone sidecar keeps its own key file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fromB64u, HOST_ID_BYTES, RELAY_TOKEN_MAX_CHARS } from "./credentials.ts";
import { RELAY_HOST } from "./descriptor.ts";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "./noise.ts";
import { DATA_DIR, ensureDataDir, writeFileAtomic } from "../state.ts";

export interface RelayConfig {
  hostId: Buffer;
  nodes: string[];
  token: string;
}

export interface E2EConfig {
  /** Null turns end-to-end off. */
  transportKey: KeyPair | null;
  relay: RelayConfig | null;
}

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Exact: anything malformed is refused whole, so a bad relay field can never half-apply. */
export function parseRelayConfig(value: unknown): RelayConfig | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const { hostId, nodes, relayToken } = value as Record<string, unknown>;
  const id = typeof hostId === "string" ? fromB64u(hostId) : null;
  if (!id || id.length !== HOST_ID_BYTES) return "invalid";
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 4) return "invalid";
  if (!nodes.every((node): node is string => typeof node === "string" && RELAY_HOST.test(node))) return "invalid";
  if (typeof relayToken !== "string" || relayToken.length > RELAY_TOKEN_MAX_CHARS || !TOKEN.test(relayToken)) return "invalid";
  return { hostId: id, nodes: [...nodes], token: relayToken };
}

/** The desktop app's `openmausbot:companion-e2e` message: `{transportKey, relay}`, the key as b64u of the 32-byte
 * private scalar. */
export function parseE2EMessage(message: Record<string, unknown>): E2EConfig | null {
  let transportKey: KeyPair | null = null;
  if (message.transportKey !== null) {
    const raw = typeof message.transportKey === "string" ? fromB64u(message.transportKey) : null;
    if (!raw || raw.length !== 32) return null;
    try {
      transportKey = keyPairFromPrivate(raw);
    } catch {
      return null;
    }
  }
  const relay = parseRelayConfig(message.relay);
  if (relay === "invalid" || (relay && !transportKey)) return null;
  return { transportKey, relay };
}

const KEY_FILE = () => join(DATA_DIR, "e2e-key.json");

/** A standalone sidecar's transport key, created once with mode 0600 beside devices.json. */
export function standaloneTransportKey(): KeyPair {
  const file = KEY_FILE();
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; privateKey?: unknown };
    const raw = parsed.v === 1 && typeof parsed.privateKey === "string" ? fromB64u(parsed.privateKey) : null;
    if (!raw || raw.length !== 32) throw new Error(`${file} is not a transport key`);
    return keyPairFromPrivate(raw);
  }
  const key = generateKeyPair();
  ensureDataDir();
  writeFileAtomic(file, JSON.stringify({ v: 1, privateKey: key.privateKey.toString("base64url") }));
  return key;
}

/** Test-only: dial `ws://127.0.0.1:<port>` instead of `wss://<node>`. Loopback or TLS only. */
export function relayBaseUrlOverride(value: string | undefined): ((node: string) => string) | undefined {
  if (!value) return undefined;
  if (!/^(wss:\/\/[a-z0-9.-]+(:\d+)?|ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(value)) return undefined;
  return () => value;
}
