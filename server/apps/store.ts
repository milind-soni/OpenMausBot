// Per-app settings in <DATA_DIR>/apps.json (owner-only, atomic writes).
// Tokens are write-only: nothing here returns one to the renderer — callers
// get `tokenConfigured` booleans. Only the harness reads the token, to add
// it to requests it forwards to the app.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { readJsonFile, restrictToOwner, writeJsonAtomic } from "../json-file.ts";
import { findApp } from "./catalog.ts";

export interface StoredApp {
  endpoint?: string;
  token?: string;
}

interface AppsFile {
  apps?: Record<string, StoredApp>;
}

const file = () => join(DATA_DIR, "apps.json");

function read(): Record<string, StoredApp> {
  restrictToOwner(file());
  const disk = readJsonFile<AppsFile>(file(), {});
  return disk.apps && typeof disk.apps === "object" ? disk.apps : {};
}

function write(apps: Record<string, StoredApp>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(file(), { apps });
}

/** Loopback only: a pasted URL must never carry the token off this computer. */
export function validateLocalEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a full address, like http://127.0.0.1:19501/mcp.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://.");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Apps connect only to this computer (127.0.0.1 or localhost).");
  }
  if (url.username || url.password) throw new Error("Don't put a name or password in the address.");
  return url.href;
}

/** The effective connection for an app: saved values over catalog defaults. */
export function appConnection(id: string): { endpoint: string; token?: string } {
  const app = findApp(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  const saved = read()[app.id] ?? {};
  return { endpoint: saved.endpoint ?? app.defaultEndpoint, token: saved.token || undefined };
}

export function appSettingsSummary(id: string): { endpoint: string; customEndpoint: boolean; tokenConfigured: boolean } {
  const app = findApp(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  const saved = read()[app.id] ?? {};
  return {
    endpoint: saved.endpoint ?? app.defaultEndpoint,
    customEndpoint: Boolean(saved.endpoint && saved.endpoint !== app.defaultEndpoint),
    tokenConfigured: Boolean(saved.token),
  };
}

/** Merge a patch. `endpoint: ""` resets to the default; `token: ""` is ignored (write-only field left blank). */
export function saveAppSettings(id: string, patch: { endpoint?: unknown; token?: unknown }): void {
  const app = findApp(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  const apps = read();
  const next: StoredApp = { ...apps[app.id] };
  if (typeof patch.endpoint === "string") {
    if (patch.endpoint.trim() === "" || patch.endpoint.trim() === app.defaultEndpoint) delete next.endpoint;
    else next.endpoint = validateLocalEndpoint(patch.endpoint);
  }
  if (typeof patch.token === "string" && patch.token.trim()) {
    const token = patch.token.trim();
    if (token.length > 4096 || /\s/.test(token)) throw new Error("That doesn't look like an access token. Copy it again from the app.");
    next.token = token;
  }
  apps[app.id] = next;
  write(apps);
}

export function removeAppSettings(id: string): void {
  const app = findApp(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  const apps = read();
  delete apps[app.id];
  write(apps);
}
