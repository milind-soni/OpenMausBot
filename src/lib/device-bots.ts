import { vpsServerId, type BotComputerKind, type BotComputerRow } from "../../shared/bot-computers";
import type { Device, DeviceSources } from "./devices";
import { t } from "./i18n";

type Kind = Exclude<BotComputerKind, "auto">;

const kindOf = (row: BotComputerRow): Kind | undefined => (row.kind === "auto" ? row.autoKind : row.kind);

function cloudDesktop(computerId: string, rows: readonly BotComputerRow[], botName: (botId: string) => string | null): Device {
  const latest = rows.reduce((best, row) => ((row.stateAt ?? -1) > (best.stateAt ?? -1) ? row : best));
  const owner = botName(computerId.slice("cloud:".length));
  const name = latest.name ?? (owner ? t("devicesPage.desktopOf", { name: owner }) : t("devicesPage.kind.cloudDesktop"));
  const state = latest.state;
  const shown = state === "none" || state === "unknown" ? {} : { desktop: state };
  const status = state === "ready" ? "online" : state === "asleep" || state === "unreachable" ? "offline" : "unknown";
  return {
    id: computerId, kind: "vm", name, status, ...(state === "unreachable" ? { note: "unreachable" as const } : {}), ...shown,
    route: "cloud", routes: ["cloud"], sources: [{ type: "desktop", id: computerId }], canRunBots: false, canHostComputer: true, actions: [],
  };
}

/**
 * The bots on each device, from what the server last knew. This place gets the bots on its own private desktop (and on
 * This computer, the ones that work on it); a server bots reach over SSH gets its own; each cloud desktop becomes a
 * device of its own. Rows with no computer (the browser alone, no screen, an Auto not yet settled) are left out.
 */
export function withBots(devices: readonly Device[], rows: readonly BotComputerRow[] | null | undefined, here: DeviceSources["here"]["kind"],
  botName: (botId: string) => string | null): Device[] {
  if (!rows?.length) return [...devices];
  const onDevice = new Map<string, string[]>();
  const desktops = new Map<string, BotComputerRow[]>();
  const add = (deviceId: string, botId: string) => {
    const bots = onDevice.get(deviceId) ?? [];
    if (!bots.includes(botId)) onDevice.set(deviceId, [...bots, botId]);
  };
  const vpsDevice = (serverId: string) => devices.find((device) => device.sources.some((source) => source.type === "vps" && vpsServerId(source.id) === serverId));
  for (const row of rows) {
    const kind = kindOf(row);
    if (!kind || !row.computerId) continue;
    if (kind === "vm" || (kind === "local" && here === "computer")) add("here", row.botId);
    else if (kind === "vps" && row.vps) {
      const device = vpsDevice(row.vps.serverId);
      if (device) add(device.id, row.botId);
    } else if (kind === "cloud") {
      desktops.set(row.computerId, [...(desktops.get(row.computerId) ?? []), row]);
      add(row.computerId, row.botId);
    }
  }
  const made = [...desktops].map(([computerId, list]) => cloudDesktop(computerId, list, botName));
  return [...devices, ...made].map((device) => {
    const bots = onDevice.get(device.id);
    return bots ? { ...device, bots } : device;
  });
}
