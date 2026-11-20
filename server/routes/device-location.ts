import { DEVICE_LOCATION_HEADER, DEVICE_LOCATION_PATH } from "../../shared/device-location.ts";
import type { DeviceLocations } from "../host/device-location.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const isDeviceLocationTool = (method: string, path: string): boolean =>
  method === "POST" && path === "/api/internal/device-location";

export function createDeviceLocationRoutes(locations: DeviceLocations, sessionLive: (id: string) => boolean): RouteHandler {
  return async ({ method, path, req, res, auth, json, readBody }) => {
    if (method !== "POST" || path !== DEVICE_LOCATION_PATH) return PASS;
    const body = await readBody(req, 1024);
    if (auth.kind === "session" && !sessionLive(auth.session.id)) return json(res, 401, { error: "Session ended." });
    const received = locations.reply(auth, req.headers[DEVICE_LOCATION_HEADER], body);
    return json(res, received ? 200 : 404, { ok: received });
  };
}
