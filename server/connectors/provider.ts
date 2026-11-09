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
export function readConnectorSettings(
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

export function openConnectorConfigurationError(settings: OpenConnectorSettings, env: NodeJS.ProcessEnv): string | undefined {
  if (!settings.url?.trim()) return 'OpenConnector is selected but has no URL; set OMB_OPENCONNECTOR_URL';
  if (!settings.adminTokenRef?.trim() && !env[OPENCONNECTOR_ADMIN_TOKEN_ENV]?.trim()) {
    return 'OpenConnector is selected but has no admin token; set OMB_OPENCONNECTOR_ADMIN_TOKEN or OMB_OPENCONNECTOR_ADMIN_TOKEN_REF';
  }
  return undefined;
}

/** Validation belongs to operations that need OpenConnector, while status can report setup cleanly. */
export function assertOpenConnectorSettings(settings: ConnectorSettings, env: NodeJS.ProcessEnv = process.env): void {
  if (settings.provider !== "openconnector") return;
  const error = openConnectorConfigurationError(settings.openconnector, env);
  if (error) throw new Error(error);
}

export function loadConnectorSettings(
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredConnectors | null = readStoredConnectors(),
): ConnectorSettings {
  return readConnectorSettings(env, stored);
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
  const settings = readConnectorSettings(env);
  const tokenIsResolvable = () => {
    try {
      return resolveTokenRef(settings.openconnector.adminTokenRef, env) !== undefined;
    } catch {
      return false;
    }
  };
  const resolvedToken = () => {
    try {
      return resolveToken(settings.openconnector, env);
    } catch {
      return undefined;
    }
  };
  const key = JSON.stringify([
    settings.provider,
    settings.openconnector.url,
    settings.openconnector.adminTokenRef,
    tokenIsResolvable(),
    createHash("sha256").update(resolvedToken() ?? "").digest("hex"),
  ]);
  if (selected?.key === key) return selected.provider;
  selected?.provider.dispose?.();
  const provider = selectProvider(settings, env);
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

/** The admin token the settings page may show: configured-and-last4 only, never the value. A reference
 * that cannot be resolved (a missing file, an unset env name) reads as unconfigured. */
export function openConnectorTokenStatus(
  settings: OpenConnectorSettings,
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; last4?: string } {
  let token: string | undefined;
  try {
    token = resolveToken(settings, env);
  } catch {
    token = undefined; // an unreadable file reference reads as unconfigured
  }
  return token ? { configured: true, ...(token.length >= 12 ? { last4: token.slice(-4) } : {}) } : { configured: false };
}
