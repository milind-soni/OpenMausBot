// Which connector backend server/composio.ts serves. Selection is config-driven with Composio as the
// default, so an unconfigured host keeps its exact previous behavior. Config habits follow the rest of
// the repo: env vars win, config.json's "connectors" key is the persistent store, and secrets are only
// referenced (env:NAME or file:PATH), never kept inline.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { parseJson } from "../schema.ts";
import { settledFileStamp } from "../settled-file.ts";
import type { ConnectorProvider } from "./types.ts";
import { composioProvider } from "./composio.ts";

export const CONNECTOR_PROVIDER_ENV = "OMB_CONNECTOR_PROVIDER";
export const OPENCONNECTOR_URL_ENV = "OMB_OPENCONNECTOR_URL";
export const OPENCONNECTOR_ADMIN_TOKEN_ENV = "OMB_OPENCONNECTOR_ADMIN_TOKEN";
export const OPENCONNECTOR_ADMIN_TOKEN_REF_ENV = "OMB_OPENCONNECTOR_ADMIN_TOKEN_REF";

export type ConnectorProviderId = "composio" | "openconnector";

const providerIdSchema = z.enum(["composio", "openconnector"]);

const storedConnectorsSchema = z.object({
  provider: providerIdSchema.optional(),
  openconnector: z.object({
    url: z.string().trim().max(2048).optional(),
    /** Where the admin token lives: "env:VAR_NAME" or "file:/abs/path". The token itself is never stored here. */
    adminTokenRef: z.string().trim().max(400).optional(),
  }).optional(),
}).optional();

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
    const document = z.object({ connectors: storedConnectorsSchema }).safeParse(
      parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")),
    );
    return document.success ? (document.data.connectors ?? null) : null;
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
  return {
    provider,
    openconnector: {
      url: env[OPENCONNECTOR_URL_ENV] ?? stored?.openconnector?.url,
      adminTokenRef: env[OPENCONNECTOR_ADMIN_TOKEN_REF_ENV] ?? stored?.openconnector?.adminTokenRef,
    },
  };
}

/** Resolves an admin-token reference without ever persisting the value: "env:NAME" reads a variable,
 * "file:/abs/path" reads an owner-only file, a bare NAME is read as an env variable. */
export function resolveTokenRef(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = ref?.trim();
  if (!value) return undefined;
  if (value.startsWith("env:")) return env[value.slice(4)]?.trim() || undefined;
  if (value.startsWith("file:")) {
    try {
      return readFileSync(value.slice(5), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return env[value]?.trim() || undefined;
}

let selected: { key: string; provider: ConnectorProvider } | null = null;

/** The provider for this process, memoized until the env or config.json changes. */
export function connectorProvider(env: NodeJS.ProcessEnv = process.env): ConnectorProvider {
  const settings = loadConnectorSettings(env);
  const key = JSON.stringify([
    settings.provider,
    settings.openconnector.url,
    settings.openconnector.adminTokenRef,
    resolveTokenRef(settings.openconnector.adminTokenRef, env) !== undefined,
    settledFileStamp(join(DATA_DIR, "config.json")),
  ]);
  if (selected?.key === key) return selected.provider;
  const provider = selectProvider(settings);
  selected = { key, provider };
  return provider;
}

function selectProvider(settings: ConnectorSettings): ConnectorProvider {
  if (settings.provider === "openconnector") {
    // Wired in the OpenConnector provider (server/connectors/openconnector/); selecting it before that lands is a config error.
    throw new Error('Connector provider "openconnector" is not available yet');
  }
  return composioProvider;
}
