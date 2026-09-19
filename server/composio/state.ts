// Composio connector state: backend endpoints, managed-broker access,
// transport-session memory, and the slug/record normalizers every other
// composio family shares. All mutable module state lives here.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.ts";

const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";

export function apiBase() {
  return (process.env.OMB_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

export function toolkitBase() {
  return (process.env.OMB_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

export const MAX_CONNECTED_ACCOUNT_PAGES = 100;
export const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

let managedBrokerAccess: { url: string; token: string } | null | undefined;

const managedBrokerMessageSchema = z.record(z.string(), z.unknown());
const managedBrokerToken = /^[0-9a-f]{64}$/;

function normalizeManagedBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function applyManagedBrokerMessage(message: unknown): boolean {
  const parsed = managedBrokerMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "openmausbot:managed-composio" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  setManagedBrokerAccess(parsed.data.access);
  return true;
}

export function setManagedBrokerAccess(access: unknown): void {
  if (access === null) {
    managedBrokerAccess = null;
    return;
  }
  const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
  managedBrokerAccess = { url: normalizeManagedBrokerUrl(parsed.url), token: parsed.token };
}

export function brokerAccess(): { url: string; token: string } | null {
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.OMB_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}

/** A user-owned project is an explicit choice and must win over the packaged
 * app's managed broker. An empty key means that choice was cleared, so the
 * managed service may take over again without a restart. */
export function projectApiKey(cfg: AppConfig): string | null {
  const apiKey = cfg.composio?.apiKey?.trim();
  return apiKey || null;
}

/** Composio's toolkit slug is `twitter`. Keep accepting the old `x` alias at
 * every local boundary so saved connector cards and model calls keep working. */
export function canonicalToolkitSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  return normalized === "x" ? "twitter" : normalized;
}

/** Keep credential-backed caches and transport sessions separated without
 * retaining another plaintext copy of the credential as their identity. */
export function backendFingerprint(kind: string, endpoint: string, credential: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(endpoint)
    .update("\0")
    .update(credential)
    .digest("hex");
}

const MAX_TRACKED_TRANSPORT_SESSIONS = 512;
export const transportSessionBackends = new Map<string, string>();

export function rememberTransportSession(sessionId: string, identity: string): void {
  transportSessionBackends.delete(sessionId);
  transportSessionBackends.set(sessionId, identity);
  while (transportSessionBackends.size > MAX_TRACKED_TRANSPORT_SESSIONS) {
    const oldest = transportSessionBackends.keys().next().value;
    if (oldest === undefined) break;
    transportSessionBackends.delete(oldest);
  }
}

export function canonicalServiceRecord<T>(services: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(services).map(([slug, state]) => [canonicalToolkitSlug(slug), state]),
  );
}

/** Preserve the caller's key (`x` included) while speaking canonical toolkit
 * slugs upstream. Old connector cards index status with their saved slug. */
export function requestedServiceRecord<T>(services: Record<string, T>, requested: string[]): Record<string, T> {
  const canonical = canonicalServiceRecord(services);
  return Object.fromEntries(
    requested.flatMap((slug) => {
      const state = canonical[canonicalToolkitSlug(slug)];
      return state === undefined ? [] : [[slug, state]];
    }),
  );
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (projectApiKey(cfg)) return "self-hosted";
  if (brokerAccess()) return "managed";
  return "unavailable";
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** Three answers, not two. The desktop shell sets OMB_CREDENTIAL_STORE to
 * "unavailable" when it could not read credentials.bin this launch; without
 * that signal an unreadable store is indistinguishable from a user who never
 * connected anything, and the UI wipes a list it should have kept. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.OMB_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}
