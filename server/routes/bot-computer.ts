// The bot cloud-computer HTTP routes (the Box status preview, the
// take/release/dismiss-help control panel with lease ids, the viewer-close
// action, and the provision/join/sleep/exec/screenshot/remove lifecycle
// across the Box, team-computer and VPS backends), extracted verbatim from
// index.ts's dispatch chain. Path matching, methods, and status codes are
// unchanged; the handler returns false for anything it does not own so the
// chain falls through in the same order. The module's call site sits
// exactly where the family sat — immediately after the bot-cards module and
// immediately before the chain's generic 404 — so dispatch order is
// unchanged. The lifecycle helpers, busy sets and preview caches are
// index-local and cross via deps; cfg/store are live bindings from
// ../runtime.ts and box/computerBackendFor/teamComputerOwner are imported
// from their source modules. index.ts's `return json(...)` statements became
// `json(...); return true;` (json returns void).
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention.ts";
import * as box from "../box.ts";
import { computerBackendFor } from "../computer-backend.ts";
import { teamComputerOwner } from "../team-computers.ts";
import { cfg, store } from "../runtime.ts";
import type { createComputerLifecycle, RemoteComputerProvider } from "../computer-lifecycle.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";

type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;

export function createBotComputerRoutes(deps: {
  inheritedTeamComputer: ComputerLifecycle["inheritedTeamComputer"];
  computerPreviewBot: ComputerLifecycle["computerPreviewBot"];
  computerPreviewSurface: ComputerLifecycle["computerPreviewSurface"];
  botComputerControlKey: ComputerLifecycle["botComputerControlKey"];
  botComputerControlSnapshot: ComputerLifecycle["botComputerControlSnapshot"];
  assertTeamControlCanBeTaken: ComputerLifecycle["assertTeamControlCanBeTaken"];
  claimTeamComputerLifecycle: ComputerLifecycle["claimTeamComputerLifecycle"];
  claimBotComputerLifecycle: ComputerLifecycle["claimBotComputerLifecycle"];
  botHasActiveTurn: ComputerLifecycle["botHasActiveTurn"];
  providerTransitionMessage: ComputerLifecycle["providerTransitionMessage"];
  computerProviderConfigTransitions: ComputerLifecycle["computerProviderConfigTransitions"];
  boxLifecycleBusyBots: ComputerLifecycle["boxLifecycleBusyBots"];
  vpsPreviewRequests: ComputerLifecycle["vpsPreviewRequests"];
  activeVpsThreads: ComputerLifecycle["activeVpsThreads"];
  computerControl: TurnIntegrations["computerControl"];
  controlLeaseIdSchema: TurnIntegrations["controlLeaseIdSchema"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      inheritedTeamComputer,
      computerPreviewBot,
      computerPreviewSurface,
      botComputerControlKey,
      botComputerControlSnapshot,
      assertTeamControlCanBeTaken,
      claimTeamComputerLifecycle,
      claimBotComputerLifecycle,
      botHasActiveTurn,
      providerTransitionMessage,
      computerProviderConfigTransitions,
      boxLifecycleBusyBots,
      vpsPreviewRequests,
      activeVpsThreads,
      computerControl,
      controlLeaseIdSchema,
    } = deps;
    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const surface = url.searchParams.has("threadId") ? await computerPreviewSurface(bot, bot.threadId) : "cloud";
      const computerBackend = computerBackendFor(bot);
      if (surface !== "cloud") { json(res, 200, { surface, configured: false, backend: computerBackend.kind }); return true; }
      const teamComputer = inheritedTeamComputer(bot);
      if (teamComputer) { json(res, 200, { surface, backend: "box", teamComputer: { id: teamComputer.id, name: teamComputer.name }, ...(await box.boxStatus(cfg, teamComputerOwner(teamComputer.id))) }); return true; }
      json(res, 200, { surface, backend: computerBackend.kind, ...(await computerBackend.status(cfg, bot.id)) });
      return true;
    }
    // Who is driving this bot's computer. GET is the panel's initial read;
    // POST take/release/dismiss-help are the person's three moves. The bot
    // has no verb here at all — its only voice is the internal help plea.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (method === "GET") { json(res, 200, botComputerControlSnapshot(bot.id)); return true; }
      if (method === "POST") {
        // JSON-only for the same anti-form-POST reason as every other
        // computer mutation below.
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          json(res, 415, { error: "content-type must be application/json" });
          return true;
        }
        const body = await readBody(req);
        const action = String(body.action ?? "");
        const currentBot = store.bot(bot.id);
        if (!currentBot) { json(res, 404, { error: "no such bot" }); return true; }
        const controlKey = botComputerControlKey(currentBot);
        const teamComputer = inheritedTeamComputer(currentBot);
        if (action === "take" && teamComputer) assertTeamControlCanBeTaken(teamComputer.id);
        const leaseResult =
          body.controlLeaseId === undefined
            ? null
            : controlLeaseIdSchema.safeParse(body.controlLeaseId);
        if (leaseResult && !leaseResult.success) {
          json(res, 400, { error: "controlLeaseId is invalid" });
          return true;
        }
        const controlLeaseId = leaseResult?.data;
        if (action === "take" && (boxLifecycleBusyBots.has(bot.id) || boxLifecycleBusyBots.has(controlKey))) {
          json(res, 409, { error: "this bot's cloud computer is being changed — wait before taking control" });
          return true;
        }
        if (action === "take" && controlLeaseId) {
          const result = computerControl.acquireLease(controlKey, controlLeaseId);
          json(res, 200, {
            ...result.snapshot,
            owned: result.owned,
            acquired: result.acquired,
          });
          return true;
        }
        if (action === "release" && controlLeaseId) {
          const result = computerControl.releaseLease(controlKey, controlLeaseId);
          json(res, 200, { ...result.snapshot, released: result.released });
          return true;
        }
        if (action === "take") { json(res, 200, computerControl.take(controlKey)); return true; }
        if (action === "release") { json(res, 200, computerControl.release(controlKey)); return true; }
        if (action === "dismiss-help") { json(res, 200, computerControl.dismissHelp(controlKey)); return true; }
        json(res, 400, { error: "action must be take, release, or dismiss-help" });
        return true;
      }
      json(res, 405, { error: "method not allowed" });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      json(res, 200, computerBackendFor(bot).closeViewer(bot.id));
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot|remove)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const previewOnly = m[2] === "screenshot" || m[2] === "join";
      const bot = previewOnly ? computerPreviewBot(botId, url) : store.bot(botId);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const threadPreview = previewOnly && url.searchParams.has("threadId");
      if (threadPreview && await computerPreviewSurface(bot, bot.threadId) !== "cloud") {
        json(res, 409, { error: "This conversation is not using the cloud computer" });
        return true;
      }
      // Requiring JSON makes every computer mutation a non-simple browser
      // request (same reasoning as the Local VM lifecycle routes above): a
      // hostile page cannot submit it with a form, and its cross-origin JSON
      // request dies in the preflight this server never answers. Applied to
      // both backends — the Box branch runs commands too.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const computerBackend = computerBackendFor(bot);
      const remoteProvider: RemoteComputerProvider = computerBackend.kind;
      if (computerProviderConfigTransitions.has(remoteProvider)) {
        json(res, 409, { error: providerTransitionMessage(remoteProvider) });
        return true;
      }
      if (boxLifecycleBusyBots.has(botId)) {
        json(res, 409, { error: "this bot's cloud computer is being changed — wait for it to finish" });
        return true;
      }
      const teamComputer = inheritedTeamComputer(bot);
      if (teamComputer) {
        const key = teamComputerOwner(teamComputer.id);
        if (boxLifecycleBusyBots.has(key)) { json(res, 409, { error: "This team computer is being changed; wait for it to finish" }); return true; }
        if (m[2] === "provision" || m[2] === "remove") { json(res, 409, { error: "Manage this shared computer from the Team map" }); return true; }
        if (m[2] === "exec") { json(res, 409, { error: "Use the bot's scoped computer tools for this shared desktop" }); return true; }
        if (m[2] === "join" && !computerControl.snapshot(key).held) { json(res, 409, { error: "Take control before opening this shared desktop" }); return true; }
        const release = m[2] === "sleep" ? claimTeamComputerLifecycle(teamComputer) : claimBotComputerLifecycle(key);
        try {
          if (m[2] === "join") { json(res, 200, await box.joinReadyBox(cfg, key)); return true; }
          if (m[2] === "screenshot") {
            res.setHeader("cache-control", "private, no-store");
            json(res, 200, await box.screenshotBox(cfg, key)); return true;
          }
          json(res, 200, await box.sleepBox(cfg, key));
          return true;
        } finally { release(); }
      }
      if (computerBackend.kind === "vps") {
        if (m[2] === "screenshot") {
          let preview = vpsPreviewRequests.get(botId);
          if (!preview) {
            preview = computerBackend.screenshot(cfg, botId).finally(() => {
              vpsPreviewRequests.delete(botId);
            });
            vpsPreviewRequests.set(botId, preview);
          }
          res.setHeader("cache-control", "private, no-store");
          json(res, 200, await preview);
          return true;
        }
        // Opening the existing SSH viewer can coexist with a capture. Start,
        // stop, remove and Settings deletion still exclude pending previews.
        const releaseComputerLifecycle = claimBotComputerLifecycle(botId, m[2] === "join");
        try {
          if (m[2] === "exec") {
            json(res, 409, { error: "the VPS console is available to the bot through its scoped computer tools" });
            return true;
          }
          if (m[2] === "provision" && bot.computer !== "cloud" && !bot.autoStartVps) {
            json(res, 409, { error: "Auto may start this VPS only after Start VPS automatically is enabled" });
            return true;
          }
          if ((m[2] === "sleep" || m[2] === "remove") && (bot.busy || activeVpsThreads.has(botId))) {
            json(res, 409, { error: "the VPS computer is being used by this bot — interrupt the turn first" });
            return true;
          }
          if (m[2] === "join") {
            json(res, 200, await computerBackend.join(cfg, botId));
            return true;
          }
          const action = m[2] === "provision" ? "provision" : m[2] === "remove" ? "remove" : "stop";
          json(res, 200, await computerBackend.action(cfg, botId, action));
          return true;
        } finally {
          releaseComputerLifecycle();
        }
      }
      const activeBoxTurn = botHasActiveTurn(botId);
      if (["provision", "sleep"].includes(m[2]) && activeBoxTurn) {
        json(res, 409, {
          error: CLOUD_COMPUTER_BUSY_ERROR,
        });
        return true;
      }
      // Input validity is independent of destination authorization. Preserve
      // the stable 400 contract for oversized commands without contacting the
      // provider; a valid Auto request still reaches the 409 gate below.
      let boxCommand: string | undefined;
      if (m[2] === "exec") {
        const body = await readBody(req);
        boxCommand = String(body?.command ?? "");
        if (boxCommand.length > box.MAX_REMOTE_COMMAND_LENGTH) {
          json(res, 400, {
            error: `command is too long (maximum ${box.MAX_REMOTE_COMMAND_LENGTH} characters)`,
          });
          return true;
        }
      }
      if (bot.computer !== "cloud" && !threadPreview) {
        json(res, 409, {
          error: "Choose Cloud before changing or opening this Box. Auto only checks existing computer state.",
        });
        return true;
      }
      if (m[2] === "remove") {
        // Boxes sleep and wake; only the VPS backend has a container to remove.
        json(res, 409, { error: "the cloud Box backend has no container to remove — use sleep instead" });
        return true;
      }
      const releaseComputerLifecycle = claimBotComputerLifecycle(botId);
      try {
        switch (m[2]) {
          case "provision":
            json(res, 200, await computerBackend.action(cfg, botId, "provision", { botName: bot.name }));
            return true;
          case "join":
            json(res, 200, await computerBackend.join(cfg, botId, activeBoxTurn || threadPreview ? "ready" : "wake"));
            return true;
          case "sleep":
            json(res, 200, await computerBackend.action(cfg, botId, "sleep"));
            return true;
          case "exec":
            json(res, 200, await computerBackend.action(cfg, botId, "exec", { command: boxCommand ?? "" }));
            return true;
          case "screenshot":
            res.setHeader("cache-control", "private, no-store");
            json(res, 200, await computerBackend.screenshot(cfg, botId));
            return true;
        }
      } finally {
        releaseComputerLifecycle();
      }
    }
    return false;
  };
}
