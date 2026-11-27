import { listBotPresets, ORG_PRESET_REMOVE_MESSAGE, PRESET_UNAVAILABLE_MESSAGE, type OrgInstallStatus, type PresetStore } from "../presets.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotPresetRouteDeps {
  presets: Pick<PresetStore, "list" | "resolve" | "removeFilePreset">;
  orgStatuses(): ReadonlyMap<string, OrgInstallStatus>;
}

export function createBotPresetRoutes(deps: BotPresetRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path === "/api/bot-presets" && method === "GET") {
      return json(res, 200, { presets: listBotPresets(deps.presets, deps.orgStatuses()) });
    }
    const m = path.match(/^\/api\/bot-presets\/([\w-]+)$/);
    if (!m || method !== "DELETE") return PASS;
    const removed = deps.presets.removeFilePreset(m[1]!);
    if (removed === "not_found") return json(res, 404, { error: PRESET_UNAVAILABLE_MESSAGE });
    if (removed === "organization") return json(res, 409, { error: ORG_PRESET_REMOVE_MESSAGE });
    return json(res, 200, { ok: true });
  };
}
