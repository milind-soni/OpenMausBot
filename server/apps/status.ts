// Live app status, checked over the network: an MCP initialize + tools/list
// against the app's local endpoint, mapped to plain states for the Apps
// screen and for Buddies. Cached briefly so turns don't wait on it.
import { APP_CATALOG, findApp, type AppDefinition } from "./catalog.ts";
import { listTools, McpError, type McpTool } from "./mcp-client.ts";
import { appConnection, appSettingsSummary } from "./store.ts";

export type AppState = "ready" | "needs_setup" | "not_running" | "error";

export interface AppStatus {
  state: AppState;
  /** Plain-language explanation for the user. */
  message: string;
  tools: McpTool[];
  checkedAt: number;
}

const CHECK_TIMEOUT_MS = 5_000;
const CACHE_MS = 30_000;
const cache = new Map<string, AppStatus>();

export function describeFailure(app: AppDefinition, error: unknown, hasToken: boolean): AppStatus {
  const now = Date.now();
  if (error instanceof McpError) {
    if (error.kind === "not_running") {
      return { state: "not_running", message: `${app.name} isn't running, or its automation server is turned off.`, tools: [], checkedAt: now };
    }
    if (error.kind === "unauthorized") {
      return {
        state: "needs_setup",
        message: hasToken
          ? `${app.name} didn't accept that access token. If it was regenerated in ${app.name}, copy the new one.`
          : `${app.name} is running. Add its access token to finish setup.`,
        tools: [],
        checkedAt: now,
      };
    }
    return { state: "error", message: error.message, tools: [], checkedAt: now };
  }
  return { state: "error", message: `Couldn't check ${app.name}.`, tools: [], checkedAt: now };
}

/** Check an app with explicit connection values (used by Test connection before saving). */
export async function checkConnection(app: AppDefinition, endpoint: string, token: string | undefined): Promise<AppStatus> {
  try {
    const tools = await listTools({ endpoint, token, timeoutMs: CHECK_TIMEOUT_MS });
    return { state: "ready", message: `${app.name} is connected. ${tools.length} action${tools.length === 1 ? "" : "s"} available.`, tools, checkedAt: Date.now() };
  } catch (error) {
    return describeFailure(app, error, Boolean(token));
  }
}

export async function appStatus(id: string, force = false): Promise<AppStatus> {
  const app = findApp(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  const cached = cache.get(app.id);
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  const { endpoint, token } = appConnection(app.id);
  const status = await checkConnection(app, endpoint, token);
  cache.set(app.id, status);
  return status;
}

export function invalidateAppStatus(id?: string) {
  if (id) cache.delete(id);
  else cache.clear();
}

/** Catalog + settings summary + live status for every app (no tokens). */
export async function describeApps(force = false) {
  return Promise.all(
    APP_CATALOG.map(async (app) => {
      const status = await appStatus(app.id, force);
      return {
        id: app.id,
        name: app.name,
        maker: app.maker,
        blurb: app.blurb,
        category: app.category,
        icon: app.icon,
        capabilities: app.capabilities,
        setupSteps: app.setupSteps,
        auth: app.auth,
        defaultEndpoint: app.defaultEndpoint,
        settings: appSettingsSummary(app.id),
        status: { state: status.state, message: status.message, toolCount: status.tools.length, checkedAt: status.checkedAt },
      };
    }),
  );
}
