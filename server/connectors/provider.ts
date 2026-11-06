// Which connector backend server/composio.ts serves. Selection is config-driven with Composio as the
// default, so an unconfigured host keeps its exact previous behavior. Config habits follow the rest of
// the repo: env vars win, config.json's "connectors" key is the persistent store, and secrets are only
// referenced (env:NAME or file:PATH), never kept inline.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { parseJson } from "../schema.ts";
import { settledFileStamp } from "../settled-file.ts";
import type { ConnectorProvider } from "./types.ts";
import { composioProvider } from "./composio.ts";
import { createOpenConnectorProvider } from "./openconnector/provider.ts";

export const CONNECTOR_PROVIDER_ENV = "OMB_CONNECTOR_PROVIDER";
export const OPENCONNECTOR_URL_ENV = "OMB_OPENCONNECTOR_URL";
export const OPENCONNECTOR_ADMIN_TOKEN_ENV = "OMB_OPENCONNECTOR_ADMIN_TOKEN";
export const OPENCONNECTOR_ADMIN_TOKEN_REF_ENV = "OMB_OPENCONNECTOR_ADMIN_TOKEN_REF";

export type ConnectorProviderId = "composio" | "openconnector";

const providerIdSchema = z.enum(["composio", "openconnector"]);

const storedOpenConnectorSchema = z.object({
  url: z.string().trim().max(2048).optional(),
  /** Where the admin token lives: "env:VAR_NAME" or "file:/abs/path". The token itself is never stored here. */
  adminTokenRef: z.string().trim().max(400).optional(),
});

export interface OpenConnectorSettings {
  url?: string;
  adminTokenRef?: string;
}

export interface ConnectorSettings {
  provider: ConnectorProviderId;
  openconnector: OpenConnectorSettings;
}

interface StoredConnectors {
  provider?: ConnectorProviderId;
  openconnector?: { url?: string; adminTokenRef?: string };
}

function readStoredConnectors(): StoredConnectors | null {
  try {
    const parsed = parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    const provider = z.object({ connectors: z.object({ provider: providerIdSchema.optional() }).passthrough() }).safeParse(parsed);
    const openconnector = z.object({ connectors: z.object({ openconnector: storedOpenConnectorSchema.optional() }).passthrough() }).safeParse(parsed);
    if (!provider.success && !openconnector.success) return null;
    return {
      ...(provider.success ? provider.data.connectors : {}),
      ...(openconnector.success && openconnector.data.connectors.openconnector ? { openconnector: openconnector.data.connectors.openconnector } : {}),
    };
  } catch {
    return null;
  }
}

/** env wins over config.json, matching how every other credential in this repo composes. `stored`
 * is injectable so tests never read the host's real config.json. */
export function loadConnectorSettings(
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredConnectors | null = readStoredConnectors(),
): ConnectorSettings {
  const provider = providerIdSchema.safeParse(env[CONNECTOR_PROVIDER_ENV] ?? stored?.provider).success
    ? (env[CONNECTOR_PROVIDER_ENV] ?? stored?.provider) as ConnectorProviderId
    : "composio";
  const openconnector = {
    url: env[OPENCONNECTOR_URL_ENV] ?? stored?.openconnector?.url,
    adminTokenRef: env[OPENCONNECTOR_ADMIN_TOKEN_REF_ENV] ?? stored?.openconnector?.adminTokenRef,
  };
  return { provider, openconnector };
}

/** Validation belongs to operations that need OpenConnector, while status can report setup cleanly. */
export function assertOpenConnectorSettings(settings: ConnectorSettings, env: NodeJS.ProcessEnv = process.env): void {
  if (settings.provider !== "openconnector") return;
  if (!settings.openconnector.url?.trim()) throw new Error('OpenConnector is selected but has no URL; set OMB_OPENCONNECTOR_URL');
  if (!settings.openconnector.adminTokenRef && !env[OPENCONNECTOR_ADMIN_TOKEN_ENV]?.trim()) {
    throw new Error('OpenConnector is selected but has no admin token; set OMB_OPENCONNECTOR_ADMIN_TOKEN or OMB_OPENCONNECTOR_ADMIN_TOKEN_REF');
  }
}

/** Resolves an admin-token reference without ever persisting the value: "env:NAME" reads a variable,
 * "file:/abs/path" reads an owner-only file, a bare NAME is read as an env variable. */
export function resolveTokenRef(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = ref?.trim();
  if (!value) return undefined;
  if (value.startsWith("env:")) return env[value.slice(4)]?.trim() || undefined;
  if (value.startsWith("file:")) {
    const path = value.slice(5);
    const mode = statSync(path).mode;
    if (process.platform !== "win32" && mode & 0o077) {
      throw new Error(`OpenConnector token file ${path} is readable by group or other; chmod 600 it and rotate the token if it may have been exposed`);
    }
    return readFileSync(path, "utf8").trim() || undefined;
  }
  return env[value]?.trim() || undefined;
}

let selected: { key: string; provider: ConnectorProvider } | null = null;

/** The provider for this process, memoized until the env or config.json changes. */
export function connectorProvider(env: NodeJS.ProcessEnv = process.env): ConnectorProvider {
  const settings = loadConnectorSettings(env);
  let resolvedToken: string | undefined;
  let tokenResolvable = false;
  if (settings.provider === "openconnector") {
    try {
      resolvedToken = resolveToken(settings.openconnector, env);
      tokenResolvable = true;
    } catch {
      tokenResolvable = false;
    }
  }
  const key = JSON.stringify([
    settings.provider,
    settings.openconnector.url,
    settings.openconnector.adminTokenRef,
    tokenResolvable,
    createHash("sha256").update(resolvedToken ?? "").digest("hex"),
    settledFileStamp(join(DATA_DIR, "config.json")),
  ]);
  if (selected?.key === key) return selected.provider;
  let provider: ConnectorProvider;
  try {
    assertOpenConnectorSettings(settings, env);
    if (settings.provider === "openconnector" && !tokenResolvable) {
      throw new Error("OpenConnector admin token reference cannot be resolved");
    }
    provider = selectProvider(settings, env);
  } catch {
    provider = unavailableOpenConnectorProvider();
  }
  selected = { key, provider };
  return provider;
}

function resolveToken(settings: OpenConnectorSettings, env: NodeJS.ProcessEnv): string | undefined {
  return resolveTokenRef(settings.adminTokenRef, env) ?? (env[OPENCONNECTOR_ADMIN_TOKEN_ENV]?.trim() || undefined);
}

function selectProvider(settings: ConnectorSettings, env: NodeJS.ProcessEnv): ConnectorProvider {
  if (settings.provider === "openconnector") {
    return createOpenConnectorProvider({ settings: settings.openconnector, env });
  }
  return composioProvider;
}

function unavailableOpenConnectorProvider(): ConnectorProvider {
  const setupRequired = (): Error => new Error("OpenConnector setup is incomplete; set a valid URL and an admin token");
  return {
    id: "openconnector",
    mode: () => "unavailable",
    isConfigured: () => false,
    inventory: async () => ({ services: {}, complete: false }),
    tools: async () => ({}),
    serviceSlugs: async () => [],
    status: async (_cfg, slugs) => Object.fromEntries(slugs.map((slug) => [slug, {
      connected: false, pending: false, status: "not_connected", accounts: [],
    }])),
    removeService: async () => { throw setupRequired(); },
    removeAccount: async () => { throw setupRequired(); },
    prepareAuthConfigs: async () => undefined,
    authorize: async () => { throw setupRequired(); },
    catalog: async () => ({
      cards: [],
      source: "api",
      pagination: { items: 0, stalled: false, complete: false, reason: "http-error" },
    }),
    relayMcp: async (_cfg, payload) => {
      const frame = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : null;
      const bytes = new TextEncoder().encode(JSON.stringify({
        jsonrpc: "2.0",
        id: frame?.id ?? null,
        error: { code: -32000, message: "OpenConnector setup is incomplete" },
      }));
      return { status: 503, bytes, contentType: "application/json" };
    },
  };
}
