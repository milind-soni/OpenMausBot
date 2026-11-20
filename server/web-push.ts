import { readFileSync } from "node:fs";
import { join } from "node:path";
import push from "web-push";
import { z } from "zod";
import type { Notification } from "../shared/notification.ts";
import { writeFileAtomic } from "./atomic.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export function allowedPushEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
      (url.hostname === "web.push.apple.com" || url.hostname.endsWith(".push.apple.com") ||
       url.hostname === "fcm.googleapis.com" || url.hostname.endsWith(".push.services.mozilla.com") ||
       url.hostname.endsWith(".notify.windows.com"));
  } catch { return false; }
}

const registration = z.object({
  endpoint: z.string().max(4096).refine(allowedPushEndpoint).transform((raw) => new URL(raw).href),
  keys: z.object({ auth: z.string().regex(/^[\w-]{22}$/), p256dh: z.string().regex(/^B[\w-]{86}$/) }),
});
type Subscription = z.infer<typeof registration>;
type State = { vapid: ReturnType<typeof push.generateVAPIDKeys>; devices: Record<string, { subscription: Subscription; silent: boolean }> };

export function createWebPush(dir: string, live: (id: string) => boolean, send = push.sendNotification) {
  const path = join(dir, "web-push.json");
  let state: State | undefined;
  function save(next: State) {
    writeFileAtomic(path, JSON.stringify(next), { mode: 0o600 });
    state = next;
  }
  function load(create: boolean) {
    if (!state) {
      try { state = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create) save({ vapid: push.generateVAPIDKeys(), devices: {} });
      }
    }
    return state;
  }
  function forget(id: string) {
    if (!state?.devices[id]) return;
    const devices = { ...state.devices };
    delete devices[id];
    save({ ...state, devices });
  }
  const route: RouteHandler = async ({ req, res, method, path, auth, readBody, json }) => {
    if (path !== "/api/push/web") return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (auth.kind !== "session" || !live(auth.session.id)) return json(res, 403, { error: "Sign in to enable notifications" });
    const id = auth.session.id;
    const current = load(true)!;
    if (method === "GET") return json(res, 200, { publicKey: current.vapid.publicKey });
    if (method === "DELETE") { forget(id); return json(res, 200, { ok: true }); }
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "JSON required" });
    const result = z.object({ subscription: registration, silent: z.boolean() }).safeParse(await readBody(req, 8192));
    if (!result.success) return json(res, 400, { error: "Invalid push subscription" });
    if (!live(id)) return json(res, 401, { error: "Session expired" });
    const latest = load(true)!;
    const devices = Object.fromEntries(Object.entries(latest.devices).filter(([key, device]) =>
      key !== id && device.subscription.endpoint !== result.data.subscription.endpoint && live(key)));
    save({ ...latest, devices: { ...devices, [id]: result.data } });
    return json(res, 200, { ok: true });
  };
  async function offer(notification: Notification, messageId: string, reaches: (id: string) => boolean) {
    const current = load(false);
    if (!current) return;
    await Promise.all(Object.entries(current.devices).map(async ([id, device]) => {
      if (!live(id)) return forget(id);
      if (!reaches(id)) return;
      const { title, body, botId, threadId } = notification;
      try {
        await send(device.subscription, JSON.stringify({ title, body, botId, threadId, messageId, silent: device.silent }), {
          TTL: 86400, timeout: 10000, vapidDetails: { subject: "https://github.com/Charlie-BU/Charlie-MausBot", ...current.vapid },
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if ((status === 404 || status === 410) && state?.devices[id] === device) forget(id);
        else console.warn("Web Push delivery failed", status ?? "network");
      }
    }));
  }
  return { route, offer };
}
