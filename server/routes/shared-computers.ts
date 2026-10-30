// /api/shared-computers: a desktop lending its computer to this server (on a Cloud home, to My Cloud). A main-process-only
// secret binds poll, results and the device link to that desktop; with the feature off the family 404s like a build
// without it.
import { answerAsleep, type CloudPower } from "../cloud-power.ts";
import type { DeviceLinks } from "../device-links.ts";
import { requestSource, type RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { responseGone, sharedComputerRegistration, type SharedComputers } from "../shared-computers.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

const LINK = /^\/api\/shared-computers\/([\w-]+)\/link$/;

export function createSharedComputerRoutes(deps: {
  enabled: () => boolean;
  computers: SharedComputers;
  sessionLive: (id: string) => boolean;
  environmentId: string;
  /** On a Cloud home every lent computer is the owner's, under this one name. */
  cloudHomeLender: string | null;
  principal: (auth: RequestAuth) => string | null;
  personKey: (session: Pick<SessionRecord, "id" | "email">) => string;
  /** A Cloud home that agreed to sleep sends the desktop away until it wakes (server/cloud-power.ts). */
  power: () => Pick<CloudPower, "sleeping" | "sleepSignal"> | null;
  /** A Cloud home's device links (a lent computer's internet connection); null elsewhere, where the path 404s. */
  links: DeviceLinks | null;
  upgrades: Upgrades;
}): RouteHandler {
  deps.upgrades.route((path) => LINK.test(path));
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== "/api/shared-computers" && !path.startsWith("/api/shared-computers/")) return PASS;
    if (method === "GET" && path === "/api/shared-computers" && deps.enabled()) {
      return json(res, 200, { computers: deps.computers.status(deps.principal(auth)), known: deps.computers.known(deps.principal(auth)) });
    }
    const link = LINK.exec(path);
    if (link && method === "GET" && deps.enabled() && deps.links) {
      const pending = deps.upgrades.pending(req);
      if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
      if (auth.kind !== "session") return json(res, 403, { error: "Pair this desktop first" });
      if (!deps.sessionLive(auth.session.id)) return json(res, 401, { error: "Session ended" });
      const computer = deps.computers.linkable(link[1]!, auth.session.id, String(req.headers["x-omb-computer-secret"] ?? ""));
      if (pending.socket.destroyed) return;
      pending.release();
      deps.links.accept({ req, socket: pending.socket, head: pending.head }, { ...computer, seenAs: requestSource(req) }, deps.power());
      res.detachSocket(pending.socket);
      return;
    }
    if (method !== "POST" || path === "/api/shared-computers" || !deps.enabled()) return PASS;
    if (auth.kind !== "session") return json(res, 403, { error: "Pair this desktop first" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const body = await readBody(req, 4_000_000);
    if (!deps.enabled()) return json(res, 404, { error: `no route: ${method} ${path}` });
    if (!deps.sessionLive(auth.session.id)) return json(res, 401, { error: "Session ended" });
    const secret = String(req.headers["x-omb-computer-secret"] ?? "");
    if (path === "/api/shared-computers/connect") {
      const parsed = sharedComputerRegistration.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Invalid computer registration" });
      const registration = parsed.data;
      if (registration.environmentId !== deps.environmentId) return json(res, 409, { error: "Workspace identity changed. Pair again before sharing this computer." });
      if (deps.cloudHomeLender && !auth.scopes.includes("admin")) return json(res, 403, { error: "Only your own computers can be shared with the Cloud. On this computer, choose Open the Cloud in Settings → MausBot Cloud first." });
      deps.computers.register(registration, { session: auth.session.id, person: deps.cloudHomeLender ?? deps.personKey(auth.session) }, secret);
      return json(res, 200, { ok: true });
    }
    const route = /^\/api\/shared-computers\/([\w-]+)\/(poll|lease|result|disconnect)$/.exec(path);
    if (!route) return json(res, 404, { error: "not found" });
    const [, id, action] = route;
    if (action === "poll") {
      const power = deps.power();
      if (power?.sleeping()) return answerAsleep(res, json);
      const job = await deps.computers.poll(id, auth.session.id, secret, power ? AbortSignal.any([responseGone(res), power.sleepSignal()]) : responseGone(res));
      if (!job && power?.sleeping()) return answerAsleep(res, json);
      return json(res, 200, { job });
    }
    if (action === "lease") return json(res, 200, { active: deps.computers.liveJob(id, auth.session.id, secret, String(body?.jobId)) });
    if (action === "result") deps.computers.complete(id, auth.session.id, secret, String(body?.jobId), body?.result);
    if (action === "disconnect") deps.computers.disconnect(id, auth.session.id, secret, body?.paused === true);
    return json(res, 200, { ok: true });
  };
}
