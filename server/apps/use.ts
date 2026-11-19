// What Buddies see through the harness proxy: list_apps and use_app. The
// harness adds the stored token when forwarding, so it never reaches an
// agent process, its config, or its environment.
import { APP_CATALOG, findApp } from "./catalog.ts";
import { callTool } from "./mcp-client.ts";
import { appStatus, describeFailure, invalidateAppStatus } from "./status.ts";
import { appConnection } from "./store.ts";

/** App work (renders, exports) can take a while; bounded so a turn can't hang forever. */
const CALL_TIMEOUT_MS = 10 * 60_000;

export async function listAppsForBuddy(appId?: string) {
  const apps = appId ? [findApp(appId)].filter((a) => a !== undefined) : [...APP_CATALOG];
  if (appId && !apps.length) throw new Error(`Unknown app: ${appId}. Call list_apps without app_id to see the available apps.`);
  return Promise.all(
    apps.map(async (app) => {
      const status = await appStatus(app.id, true);
      return {
        id: app.id,
        name: app.name,
        status: status.state,
        message: status.message,
        good_for: app.capabilities,
        notes: app.buddyNotes,
        ...(status.state === "ready"
          ? {
              // full schemas only when asked about one app — keeps the overview short
              actions: status.tools.map((t) => (appId ? t : { name: t.name, description: t.description })),
            }
          : { setup_steps: app.setupSteps }),
      };
    }),
  );
}

export async function useApp(appId: string, tool: string, args: Record<string, unknown>) {
  const app = findApp(appId);
  if (!app) throw new Error(`Unknown app: ${appId}.`);
  const status = await appStatus(app.id);
  if (status.state !== "ready") {
    throw new Error(`${app.name} isn't ready: ${status.message} Setup steps: ${app.setupSteps.join(" ")}`);
  }
  if (status.tools.length && !status.tools.some((t) => t.name === tool)) {
    throw new Error(`${app.name} has no action named "${tool}". Call list_apps with app_id "${app.id}" to see its actions.`);
  }
  const { endpoint, token } = appConnection(app.id);
  try {
    return await callTool({ endpoint, token, timeoutMs: CALL_TIMEOUT_MS }, tool, args);
  } catch (error) {
    invalidateAppStatus(app.id);
    const failure = describeFailure(app, error, Boolean(token));
    throw new Error(failure.state === "error" ? (error as Error).message : failure.message);
  }
}
