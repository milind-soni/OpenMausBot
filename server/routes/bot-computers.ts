// Polled every few seconds by a devices map, so it reads only what this server already holds: the bots, the
// config, and the last answers other code got. It never looks at a computer, a provider, Docker, SSH or a screen.
import { vpsServerId, type BotComputerKind, type BotComputerRow, type BotComputersPayload, type BotComputerState } from "../../shared/bot-computers.ts";
import { boatIdOf, deadBoatOf } from "../boat.ts";
import { boatHealth } from "../boat-health.ts";
import { mapComputerState, type ComputerFrames } from "../computer-frames.ts";
import type { AppConfig } from "../config.ts";
import { lastLocalVmStatus, type LocalVmTarget } from "../container-computer.ts";
import { answerAsleep, backgroundWhileAsleep } from "../cloud-power.ts";
import { shouldMountLocalComputer } from "../local-routing.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import type { SurfacePlan } from "../surface.ts";
import { teamComputerOwner, type TeamComputers } from "../team-computers.ts";
import { lastVpsStatus, vpsContainerName } from "../vps-computer.ts";
import { vpsConfigForBot, vpsSshAliasForBot } from "../vps-hosts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const BOT_COMPUTERS_PATH = "/api/computers/bots";

/** What index.ts knows about a bot's turns; every member answers from memory. */
export interface BotComputersHost {
  /** The place a turn in this chat (or the bot's own) would get, as turnSurfacePlan says. */
  surfacePlan(bot: BotRecord, threadId?: string): Pick<SurfacePlan, "computer" | "browser">;
  visibleFor(auth: RequestAuth): { bot(botId: string): boolean; thread(threadId: string): boolean };
  engineCapabilities(bot: BotRecord): { computerMcp?: boolean; localComputerMcp?: boolean } | undefined;
  cloudHome: boolean;
  /** The desktop app handed this server its computer's driver. */
  thisComputerConnected(): boolean;
}

export interface BotComputersRouteDeps {
  cfg: AppConfig;
  store: Pick<Store, "bots" | "tasks">;
  teamComputers: Pick<TeamComputers, "forBot">;
  frames: Pick<ComputerFrames, "machine" | "available" | "listedAt">;
  localVmSeen: Pick<Set<string>, "has">;
  localVmActiveThreads: Pick<Map<string, string>, "has">;
  localVmTargetForStatus(botId: string, threadId?: string): LocalVmTarget;
  botComputers: BotComputersHost;
  now?(): number;
  platform?: NodeJS.Platform;
}

type Place = Omit<BotComputerRow, "botId" | "threadId">;
type Reading = { state: BotComputerState; at: number | null };

const UNKNOWN: Reading = { state: "unknown", at: null };

function newest(readings: readonly Reading[]): Reading {
  return readings.reduce<Reading | null>((best, one) => (!best || (one.at ?? -1) > (best.at ?? -1) ? one : best), null) ?? UNKNOWN;
}

/** A desktop container, a Local VM's or a VPS computer's, by the last status read of it. */
export function containerState(status: { daemonUp: boolean; container: "running" | "stopped" | "missing"; desktopReady: boolean; ready: boolean }): BotComputerState {
  if (!status.daemonUp) return "unreachable";
  if (status.container === "missing") return "none";
  if (status.container === "stopped") return "asleep";
  if (status.ready) return "ready";
  return status.desktopReady ? "unreachable" : "starting";
}

const CLOUD_STATES: Record<ReturnType<typeof mapComputerState>, BotComputerState> = {
  idle: "ready", working: "ready", starting: "starting", asleep: "asleep", problem: "unreachable", off: "unknown",
};

export function botComputerRows(deps: BotComputersRouteDeps, visible: ReturnType<BotComputersHost["visibleFor"]>): BotComputerRow[] {
  const { cfg, store, teamComputers, frames, botComputers: host } = deps;
  const now = deps.now?.() ?? Date.now();
  let connected: boolean | undefined;
  const thisComputer = () => (connected ??= host.thisComputerConnected());

  const cloudReading = (owner: string, boxId: string | undefined): Reading => {
    const since = boxId ? boatHealth.notRespondingSince(boxId) : null;
    if (since !== null) return { state: "unreachable", at: since };
    const readings: Reading[] = [];
    const listedAt = frames.available() ? frames.listedAt() : null;
    if (listedAt !== null) {
      const machine = frames.machine(owner);
      readings.push({ state: machine ? CLOUD_STATES[mapComputerState(machine, false)] : "none", at: listedAt });
    }
    const answeredAt = boxId ? boatHealth.lastAnsweredAt(boxId) : null;
    if (answeredAt !== null) readings.push({ state: "ready", at: answeredAt });
    if (!readings.length && deadBoatOf(owner)) return { state: "unreachable", at: null };
    return newest(readings);
  };

  const describe = (kind: Exclude<BotComputerKind, "auto">, bot: BotRecord, threadId: string | undefined): Place => {
    if (kind === "cloud") {
      const team = teamComputers.forBot(bot);
      const owner = team ? teamComputerOwner(team.id) : bot.id;
      const boxId = boatIdOf(owner) ?? frames.machine(owner)?.boxId;
      const reading = cloudReading(owner, boxId);
      return {
        kind, computerId: `cloud:${owner}`, name: team?.name ?? null, state: reading.state, stateAt: reading.at,
        ...(team ? { teamComputerId: team.id } : {}), ...(boxId ? { boxId } : {}),
      };
    }
    if (kind === "vps") {
      const alias = vpsSshAliasForBot(cfg, bot);
      if (!alias) return { kind, computerId: null, name: null, state: "none", stateAt: null };
      const container = vpsContainerName(bot.id);
      const last = lastVpsStatus(vpsConfigForBot(cfg, bot), bot.id);
      return {
        kind, computerId: `vps:${alias}/${container}`, name: cfg.vpsServers?.find((server) => server.sshAlias === alias)?.name ?? null,
        state: last ? containerState(last.status) : "unknown", stateAt: last?.at ?? null,
        vps: { serverId: vpsServerId(alias), alias, container },
      };
    }
    if (kind === "vm") {
      const target = deps.localVmTargetForStatus(bot.id, threadId);
      const last = lastLocalVmStatus(target);
      const reading: Reading = deps.localVmActiveThreads.has(target.key) ? { state: "ready", at: now }
        : last ? { state: containerState(last.status), at: last.at } : UNKNOWN;
      return { kind, computerId: `vm:${target.key}`, name: null, state: reading.state, stateAt: reading.at };
    }
    if (kind === "local") {
      const ready = thisComputer();
      return { kind, computerId: "local", name: cfg.computerName?.trim() || null, state: ready ? "ready" : "unreachable", stateAt: ready ? now : null };
    }
    return { kind, computerId: null, name: null, state: kind === "off" ? "none" : "unknown", stateAt: null };
  };

  /** Auto's own order (computerPreviewSurface), resolved only where no step would have to look at a computer. */
  const autoKind = (bot: BotRecord, threadId: string | undefined, browser: boolean): Exclude<BotComputerKind, "auto"> | null => {
    const caps = host.engineCapabilities(bot);
    const vps = bot.cloudBackend === "vps";
    const vmMaybe = !host.cloudHome && caps?.computerMcp === true && deps.localVmSeen.has(deps.localVmTargetForStatus(bot.id, threadId).key);
    const local = !host.cloudHome && shouldMountLocalComputer({ requested: undefined, hostPlatform: deps.platform ?? process.platform,
      providerSupportsLocal: caps?.localComputerMcp === true }) && thisComputer();
    if (vmMaybe || (vps && local)) return null;
    if (local) return "local";
    if (vps) return "vps";
    return browser ? "browser" : "off";
  };

  const place = (bot: BotRecord, threadId?: string): Place => {
    const plan = host.surfacePlan(bot, threadId);
    if (plan.computer === undefined) {
      const resolved = autoKind(bot, threadId, plan.browser);
      return resolved ? { ...describe(resolved, bot, threadId), kind: "auto", autoKind: resolved }
        : { kind: "auto", computerId: null, name: null, state: "unknown", stateAt: null };
    }
    if (plan.computer === "off") return describe(plan.browser ? "browser" : "off", bot, threadId);
    if (plan.computer === "cloud") return describe(bot.cloudBackend === "vps" && !teamComputers.forBot(bot) ? "vps" : "cloud", bot, threadId);
    return describe(plan.computer, bot, threadId);
  };

  return store.bots.filter((bot) => !bot.hidden && visible.bot(bot.id)).flatMap((bot) => {
    const own = place(bot);
    const chats = store.tasks(bot.id).flatMap((task): BotComputerRow[] => {
      // Only a pin, or a pool seat for a bot on the Local VM, gives a chat a place of its own.
      if (task.archivedAt !== undefined || (task.surface === undefined && own.kind !== "vm" && own.autoKind !== "vm")) return [];
      if (!visible.thread(task.threadId)) return [];
      const chat = place(bot, task.threadId);
      return chat.kind === own.kind && chat.computerId === own.computerId ? [] : [{ botId: bot.id, threadId: task.threadId, ...chat }];
    });
    return [{ botId: bot.id, ...own }, ...chats];
  });
}

/** GET /api/computers/bots → BotComputersPayload. Admin-only like every computer route; rows only for what the caller sees. */
export function createBotComputersRoute(deps: BotComputersRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json }) => {
    if (method !== "GET" || path !== BOT_COMPUTERS_PATH) return PASS;
    if (backgroundWhileAsleep(path, req.headers)) return answerAsleep(res, json);
    res.setHeader("cache-control", "private, no-store");
    const payload: BotComputersPayload = { now: deps.now?.() ?? Date.now(), rows: botComputerRows(deps, deps.botComputers.visibleFor(auth)) };
    return json(res, 200, payload);
  };
}
