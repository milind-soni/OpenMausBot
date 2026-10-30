import * as boat from "../boat.ts";
import type { ComputerControl } from "../computer-control.ts";
import type { MapComputer, MapComputersPayload } from "../../shared/map-computer.ts";
import { createComputerFrames, mapComputerState, type ComputerFrames, type FrameMachine } from "../computer-frames.ts";
import type { AppConfig } from "../config.ts";
import { latestTurnFrame } from "../screen-frame-source.ts";
import { sectionKey, type BotRecord, type Store } from "../store.ts";
import { teamComputerOwner, type TeamComputerRecord, type TeamComputers } from "../team-computers.ts";
import type { RemoteComputerProvider } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Small enough for a wall of live screens; the bot's own turn frames stay full size. */
export const MAP_FRAME_WIDTH = 480;
const MAP_FRAME_QUALITY = 60;
const MAP_FRAME_PATH = "/tmp/ogb-map-frame.jpg";

export interface ComputerFramesRouteDeps {
  cfg: AppConfig;
  store: Pick<Store, "bots">;
  teamComputers: Pick<TeamComputers, "list">;
  computerControl: Pick<ComputerControl, "snapshot">;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
  managedBoatOwners(): boat.ManagedBoatOwner[];
  botHasActiveTurn(botId: string): boolean;
  teamComputerInUse(computer: TeamComputerRecord): boolean;
}

type MapBot = Pick<BotRecord, "id" | "name" | "section" | "computer" | "cloudBackend" | "hidden">;

/** Auto bots of a team use its computer; a bot set to its own cloud computer, or one that already has one, gets its own. */
export function mapComputers(input: {
  bots: readonly MapBot[];
  teamComputers: readonly Pick<TeamComputerRecord, "id" | "name" | "section">[];
  machine(owner: string): FrameMachine | undefined;
  working(owner: string): boolean;
}): Omit<MapComputer, "frame">[] {
  const bots = input.bots.filter((bot) => !bot.hidden);
  const teams = input.teamComputers.filter((computer) => computer.section !== null);
  const sharedBy = (computer: (typeof teams)[number]) => bots.filter((bot) =>
    bot.computer === undefined && bot.cloudBackend !== "vps" && sectionKey(bot.section) === computer.section);
  const usesTeam = new Set(teams.flatMap((computer) => sharedBy(computer).map((bot) => bot.id)));
  const own = bots.filter((bot) => bot.cloudBackend !== "vps" && (bot.computer === "cloud" || (!usesTeam.has(bot.id) && input.machine(bot.id) !== undefined)));
  return [
    ...own.map((bot) => ({
      id: bot.id, kind: "bot" as const, name: bot.name, botIds: [bot.id],
      state: mapComputerState(input.machine(bot.id), input.working(bot.id)),
    })),
    ...teams.map((computer) => {
      const owner = teamComputerOwner(computer.id);
      return {
        id: owner, kind: "team" as const, name: computer.name, section: computer.section!, botIds: sharedBy(computer).map((bot) => bot.id),
        state: mapComputerState(input.machine(owner), input.working(owner)),
      };
    }),
  ];
}

export function parseHave(raw: string | null): Map<string, string> {
  const have = new Map<string, string>();
  for (const entry of (raw ?? "").split(",").slice(0, 500)) {
    const at = entry.lastIndexOf(":");
    if (at > 0) have.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return have;
}

/** Map frames go to anyone without that version; a turn frame only to a caller with no frame yet, since the event stream carries the rest. */
export function frameForCaller(frame: NonNullable<ReturnType<ComputerFrames["frame"]>>, held: string | undefined): NonNullable<MapComputer["frame"]> {
  const send = held === undefined || (frame.source === "map" && held !== frame.version);
  return { version: frame.version, at: frame.at, mime: frame.mime, source: frame.source, ...(send ? { data: frame.data } : {}) };
}

async function captureThumbnail(cfg: AppConfig, boxId: string, signal: AbortSignal): Promise<{ data: string; mime: string }> {
  const command = boat.panelShotCommand({ width: MAP_FRAME_WIDTH, quality: MAP_FRAME_QUALITY, framePath: MAP_FRAME_PATH });
  const out = await boat.runCommand(cfg, boxId, command, { timeoutMs: 20_000, signal });
  if (!/captured/.test(out.stdout)) throw new Error("screen capture failed on the cloud computer");
  const data = await boat.readFileBase64(cfg, boxId, MAP_FRAME_PATH, signal);
  if (!data) throw new Error("could not read the frame back from the cloud computer");
  return { data, mime: "image/jpeg" };
}

/** GET /api/computers/frames?have=ID:VERSION,… → `{ configured, available, now, computers }`. Admin-only like every computer route. */
export function createComputerFramesRoutes(deps: ComputerFramesRouteDeps, frames?: ComputerFrames): RouteHandler {
  const { cfg, store, teamComputers, computerControl } = deps;
  const teamFor = (owner: string) => teamComputers.list().find((computer) => teamComputerOwner(computer.id) === owner);
  const working = (owner: string) => {
    const team = teamFor(owner);
    return team ? deps.teamComputerInUse(team) : deps.botHasActiveTurn(owner);
  };
  const cache = frames ?? createComputerFrames({
    listMachines: async () => {
      const inventory = await boat.listManagedBoats(cfg, deps.managedBoatOwners(), { adoptLegacy: false });
      if (!inventory.available) return null;
      return inventory.instances.flatMap((instance) => instance.ownerBotId && instance.state !== "removing"
        ? [{ owner: instance.ownerBotId, boxId: instance.boxId, state: instance.state }] : []);
    },
    capture: (boxId, signal) => captureThumbnail(cfg, boxId, signal),
    turnFrame: (boxId) => {
      const turn = latestTurnFrame(`computer:box:${boxId}`);
      return turn ? { data: turn.frame.png, mime: turn.frame.mime, at: turn.at } : undefined;
    },
    working,
    held: (owner) => computerControl.snapshot(owner).held,
    paused: () => deps.computerProviderConfigTransitions.has("box") || !boat.boatConfigured(cfg),
  });
  return async ({ res, url, path, method, json }) => {
    if (method !== "GET" || path !== "/api/computers/frames") return PASS;
    res.setHeader("cache-control", "private, no-store");
    const configured = boat.boatConfigured(cfg);
    if (configured) await cache.watch();
    const have = parseHave(url.searchParams.get("have"));
    const computers: MapComputer[] = mapComputers({
      bots: store.bots, teamComputers: teamComputers.list(),
      machine: (owner) => configured ? cache.machine(owner) : undefined, working,
    }).map((computer) => {
      const frame = configured ? cache.frame(computer.id) : undefined;
      return frame ? { ...computer, frame: frameForCaller(frame, have.get(computer.id)) } : computer;
    });
    const payload: MapComputersPayload = { configured, available: configured && cache.available(), now: Date.now(), computers };
    return json(res, 200, payload);
  };
}
