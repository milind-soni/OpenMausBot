// The workspace comms HTTP routes (the desktop shared-computer-control
// lease endpoint, the paired-desktop shared-computers connector family,
// the OMB_TEST_INTERNAL_CAPABILITY_KEY test-capability minter, and the
// live Team Map projection), extracted verbatim from index.ts's dispatch
// chain. Path matching, methods, and status codes are unchanged; the
// handler returns false for anything it does not own so the chain falls
// through in the same order. The three families were not contiguous: the
// single call site sits at the old shared-computer-control position,
// immediately after the auth-session module, whose /api/auth/* and
// /api/settings/custom-domain paths are disjoint from /api/desktop/*,
// /api/shared-computers/*, /api/testing/* and /api/team-map, and which
// still runs first exactly as before; the Team Map block previously sat
// after the internal peer-agent comms module, which matches only
// /api/internal/* paths — also disjoint from /api/team-map — so no request
// can change which handler wins. The sharedComputersEnabled(cfg) guards
// stay in the route conditions so a disabled feature falls through to the
// generic 404 exactly as before. The session registry, the shared-computer
// instances and the delegation watch are index-local and cross via deps;
// cfg/store/ENVIRONMENT_ID are live bindings from ../runtime.ts and the
// capability and delegation helpers are imported from their source modules.
// index.ts's `return json(...)` statements became `json(...); return true;`
// (json returns void).
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { z } from "zod";
import { json, readBody, type RouteContext } from "./http.ts";
import { sharedComputersEnabled } from "../config.ts";
import { sharedComputerRegistration, type SharedComputers } from "../shared-computers.ts";
import type { SharedComputerControl } from "../shared-computer-control.ts";
import { beginInternalCapabilityGeneration, mintInternalCapability } from "../internal-capabilities.ts";
import { pendingDelegationSnapshot } from "../delegations.ts";
import type { DelegationWatchEntry } from "../delegation-watch.ts";
import type { SessionRegistry } from "../sessions.ts";
import { cfg, ENVIRONMENT_ID, store } from "../runtime.ts";

export function createWorkspaceCommsRoutes(deps: {
  sessions: SessionRegistry;
  sharedComputers: SharedComputers;
  sharedComputerControl: SharedComputerControl;
  MAX_COMMS_DEPTH: number;
  delegationWatch: Map<string, DelegationWatchEntry>;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, auth } = rctx;
    const {
      sessions,
      sharedComputers,
      sharedComputerControl,
      MAX_COMMS_DEPTH,
      delegationWatch,
    } = deps;
    if (method === "POST" && path === "/api/desktop/shared-computer-control" && sharedComputersEnabled(cfg)) {
      if (auth.kind !== "loopback") { json(res, 403, { error: "Local desktop only" }); return true; }
      const body = await readBody(req, 1024);
      if (!sharedComputersEnabled(cfg)) { json(res, 404, { error: `no route: ${method} ${path}` }); return true; }
      if (!z.string().uuid().safeParse(body?.id).success || !["acquire", "release", "renew"].includes(body?.action)) { json(res, 400, { error: "Invalid computer lease" }); return true; }
      if (body.action === "release") sharedComputerControl.release(body.id);
      else if (body.action === "renew") sharedComputerControl.renew(body.id);
      else sharedComputerControl.acquire(body.id);
      json(res, 200, { ok: true });
      return true;
    }
    // A paired desktop registers only its own outbound connector. A second,
    // main-process-only secret binds poll/results to that exact desktop.
    // With features.sharedComputers off the whole family falls through to the
    // generic "no route" 404, so a probe cannot tell a disabled feature from
    // a build that never had one.
    if (method === "POST" && path.startsWith("/api/shared-computers/") && sharedComputersEnabled(cfg)) {
      if (auth.kind !== "session") { json(res, 403, { error: "Pair this desktop first" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "JSON required" }); return true; }
      const body = await readBody(req, 4_000_000);
      if (!sharedComputersEnabled(cfg)) { json(res, 404, { error: `no route: ${method} ${path}` }); return true; }
      if (!sessions.isLive(auth.session.id)) { json(res, 401, { error: "Session ended" }); return true; }
      const secret = String(req.headers["x-omb-computer-secret"] ?? "");
      if (path === "/api/shared-computers/connect") {
        const parsed = sharedComputerRegistration.safeParse(body);
        if (!parsed.success) { json(res, 400, { error: "Invalid computer registration" }); return true; }
        const registration = parsed.data;
        if (registration.environmentId !== ENVIRONMENT_ID) { json(res, 409, { error: "Workspace identity changed. Pair again before sharing this computer." }); return true; }
        sharedComputers.register(registration, auth.session.id, secret);
        json(res, 200, { ok: true });
        return true;
      }
      const route = /^\/api\/shared-computers\/([\w-]+)\/(poll|lease|result|disconnect)$/.exec(path);
      if (!route) { json(res, 404, { error: "not found" }); return true; }
      const [, id, action] = route;
      if (action === "poll") { json(res, 200, { job: await sharedComputers.poll(id, auth.session.id, secret) }); return true; }
      if (action === "lease") { json(res, 200, { active: sharedComputers.liveJob(id, auth.session.id, secret, String(body?.jobId)) }); return true; }
      if (action === "result") sharedComputers.complete(id, auth.session.id, secret, String(body?.jobId), body?.result);
      if (action === "disconnect") sharedComputers.disconnect(id, auth.session.id, secret);
      json(res, 200, { ok: true });
      return true;
    }
    // Isolated integration fixtures cannot invoke an MCP tool before their
    // fake provider exits, so they mint an exact synthetic turn capability
    // through a per-process high-entropy test key. The route does not exist
    // unless the launcher explicitly sets that key; production builds never
    // set it.
    if (method === "POST" && path === "/api/testing/internal-capability") {
      const expected = process.env.OMB_TEST_INTERNAL_CAPABILITY_KEY ?? "";
      const actual = Array.isArray(req.headers["x-openmausbot-test-capability"])
        ? ""
        : String(req.headers["x-openmausbot-test-capability"] ?? "");
      const expectedBytes = Buffer.from(expected);
      const actualBytes = Buffer.from(actual);
      if (
        !expected ||
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) { json(res, 404, { error: "not found" }); return true; }
      const parsed = z.object({
        botId: z.string().regex(/^[\w-]{1,128}$/),
        threadId: z.string().regex(/^[\w-]{1,128}$/),
        kind: z.enum(["agents", "connectors", "computer"]).default("agents"),
        depth: z.number().int().min(0).max(MAX_COMMS_DEPTH).default(0),
        skillAuthoring: z.boolean().default(false),
      }).strict().safeParse(await readBody(req));
      if (!parsed.success || !store.bot(parsed.data.botId)) {
        json(res, 400, { error: "invalid test capability" });
        return true;
      }
      const generation = beginInternalCapabilityGeneration(parsed.data.threadId);
      const token = mintInternalCapability({
        ...parsed.data,
        generation,
        createdBots: 0,
        openedThreads: 0,
      });
      json(res, 201, { token });
      return true;
    }
    // Live Team Map metadata. Prompts and replies never leave their
    // transcripts: this projection carries only ids, status relationships,
    // optional delegation labels, and timestamps.
    if (method === "GET" && path === "/api/team-map") {
      const visible = new Set(store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
      const collaborations = store.groups
        .filter(
          (group) =>
            group.dm === true &&
            group.memberIds.length === 2 &&
            group.memberIds.every((botId) => visible.has(botId)),
        )
        .map((group) => ({
          groupId: group.id,
          botIds: [group.memberIds[0], group.memberIds[1]] as [string, string],
          lastAt: store.messagesFor(group.threadId).at(-1)?.at ?? group.createdAt,
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
      const queued = pendingDelegationSnapshot().flatMap((item) => {
        if (!visible.has(item.sourceBotId) || !visible.has(item.toBotId)) return [];
        return [{ sourceBotId: item.sourceBotId, targetBotId: item.toBotId, reason: item.reason }];
      });
      const running = [...delegationWatch.entries()].flatMap(([threadId, watch]) => {
        if (!visible.has(watch.toBotId)) return [];
        const channel = watch.channelId ? store.group(watch.channelId) : undefined;
        const sourceBotId = watch.sourceBotId ??
          channel?.memberIds.find((botId) => botId !== watch.toBotId);
        if (!sourceBotId || !visible.has(sourceBotId)) return [];
        return [{ sourceBotId, targetBotId: watch.toBotId, threadId, groupId: channel?.id }];
      });
      json(res, 200, { collaborations, queued, running });
      return true;
    }
    return false;
  };
}
