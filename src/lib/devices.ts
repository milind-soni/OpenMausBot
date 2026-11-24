import { serverTransport } from "../../electron/server-address.mjs";
import { vpsServerId, type BotComputerState } from "../../shared/bot-computers";
import type { ServerInstall, ServerStatus } from "../../electron/server-status.mjs";
import type { CompanionState, PhoneDevice } from "./companion-types";
import type { PublicPhone } from "./phones";

/** What a device is, for its icon and its group on the map. `vm` is a bot's cloud desktop. */
export type DeviceKind = "laptop" | "desktop" | "server" | "cloud" | "phone" | "vm";
/** `unknown`: nothing says how it is right now (a Cloud the Admin runs, a server bots reach over SSH). */
export type DeviceStatus = "online" | "offline" | "attention" | "unknown";
/** How a device reaches the place on screen: `here` is the place itself. `paired` is a device signed in with a code,
 * whose way in the server does not record. */
export type DeviceRoute = "here" | "local" | "tailscale" | "relay" | "cloud" | "internet" | "ssh" | "paired";
/** What needs the person, when `status` is `attention` (or `offline` with a way to try again). `no-way-in`: a phone with
 * none of its ways to this computer turned on. */
export type DeviceNote = "update" | "signed-out" | "insecure" | "unreachable" | "reconnecting" | "no-way-in";

/** Where a device was read from, and its id there: what every action acts on. */
export type DeviceSource =
  | { type: "place"; id: string }
  | { type: "phone"; id: string }
  | { type: "phone-app"; id: string }
  | { type: "session"; id: string }
  | { type: "lent"; id: string }
  | { type: "vps"; id: string }
  | { type: "desktop"; id: string };

export type DeviceAction =
  | { type: "switch"; placeId: string }
  | { type: "remove"; source: DeviceSource }
  | { type: "copy-address"; address: string }
  | { type: "pair-again"; placeId: string; address: string }
  | { type: "retry"; placeId: string }
  | { type: "copy-update"; install: ServerInstall | null }
  | { type: "manage"; page: "ai" | "desktops" | "app"; anchor?: string }
  | { type: "turn-on-way" };

export interface Device {
  /** Stable across reads: the first source's type and its own id there, never the name. */
  id: string;
  kind: DeviceKind;
  name: string;
  status: DeviceStatus;
  /** The way it reaches this place now (or last did); `routes` holds every way any of its sources says is open. A
   * `route` missing from `routes` is not shown. */
  route: DeviceRoute;
  routes: DeviceRoute[];
  lastSeen?: number;
  version?: string;
  /** The address another device opens; for the details, never the map. */
  address?: string;
  note?: DeviceNote;
  sources: DeviceSource[];
  /** It runs bots of its own: a place this app opens, or this place itself. */
  canRunBots: boolean;
  /** Bots can work on it: this desktop, a computer lent to this place, a server bots reach over SSH. */
  canHostComputer: boolean;
  /** A device signed in with a code: what it may do here, and whose email it signed in with. */
  access?: "full" | "chat";
  email?: string;
  here?: true;
  /** The place the bots live: My Cloud, or a server the person made their home. */
  home?: true;
  /** This desktop lets that place's bots use it (Share this computer is on). */
  usesThisComputer?: boolean;
  /** Connected at this moment (a phone on its link now, a place this app is connected to), not merely seen lately. */
  live?: true;
  /** The bots that work on it, by id, from `GET /api/computers/bots`. */
  bots?: string[];
  /** A cloud desktop's last-known state; absent while nothing says. */
  desktop?: Exclude<BotComputerState, "none" | "unknown">;
  actions: DeviceAction[];
}

type SavedPlaces = Awaited<ReturnType<NonNullable<NonNullable<Window["ogb"]>["environments"]>["state"]>>;
type SavedPlace = SavedPlaces["environments"][number];

/** A device signed in to this server with a pairing code (`GET /api/auth/sessions`). */
export interface SignedInDevice {
  id: string;
  label: string;
  scopes: string[];
  lastSeenAt: number;
  email?: string;
  person?: string;
  token?: true;
}

/** A computer lent to this place (`GET /api/shared-computers`, its `known` list). */
export interface LentDevice {
  id: string;
  name: string;
  platform: "darwin" | "win32" | "linux" | null;
  online: boolean;
  lent: boolean;
  lastSeenAt: number;
}

export interface DeviceSources {
  here: { name: string; kind: "computer" | "cloud" | "team" | "server"; version?: string | null; desktop: boolean };
  /** This app's saved places: only on This computer's own page, where they are the app's own connections. */
  places?: SavedPlaces | null;
  statuses?: readonly ServerStatus[] | null;
  /** The saved places this desktop lets use it, as `computerSharing.servers()` says. */
  lending?: ReadonlyArray<{ id: string; enabled: boolean }> | null;
  companion?: Pick<CompanionState, "devices" | "connectedDeviceIds" | "routes"> | null;
  phoneApps?: readonly PublicPhone[] | null;
  sessions?: { sessions: readonly SignedInDevice[]; current: string | null } | null;
  lent?: readonly LentDevice[] | null;
  /** The servers bots reach over SSH: the SSH alias, and the name the person gave it. */
  vps?: ReadonlyArray<{ alias: string; name?: string }> | null;
  now?: number;
}

/** A signed-in device last seen this recently counts as on now: sessions record when they were used, not presence. */
export const SESSION_ONLINE_MS = 5 * 60_000;

const PHONE_LABEL = /\b(iphone|ipad|android|pixel|galaxy|phone)\b/i;
const MINI_LABEL = /\b(mac ?mini|mac studio|imac|desktop|nuc)\b/i;

/** The name two sources would both give one machine: case, punctuation and a `.local` suffix aside. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[’']/g, "").replace(/\.local$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const hostKey = (origin: string): string | null => {
  try {
    const host = new URL(origin).hostname;
    return /^[\d.]+$|:/.test(host) ? null : nameKey(host.split(".")[0] ?? "");
  } catch {
    return null;
  }
};

export function kindFromLabel(label: string): DeviceKind {
  if (PHONE_LABEL.test(label)) return "phone";
  return MINI_LABEL.test(label) ? "desktop" : "laptop";
}

function placeRoute(entry: SavedPlace): DeviceRoute {
  if (entry.home || entry.cloud || !entry.origin) return "cloud";
  const transport = serverTransport(entry.origin);
  return transport === "tailscale" ? "tailscale" : transport === "https" ? "internet" : "local";
}

const byHand = (entry: SavedPlace) => Boolean(entry.origin) && !entry.home && !entry.cloud && !("team" in entry && entry.team);

function placeState(status: ServerStatus | undefined): Pick<Device, "status" | "note"> {
  if (!status) return { status: "unknown" };
  if (status.state === "connected") return status.behind ? { status: "attention", note: "update" } : { status: "online" };
  if (status.state === "signedOut") return { status: "attention", note: "signed-out" };
  if (status.state === "insecure") return { status: "attention", note: "insecure" };
  if (status.state === "cantReach") return { status: "offline", note: "unreachable" };
  if (status.state === "reconnecting") return { status: "offline", note: "reconnecting" };
  return { status: "unknown" };
}

function fromPlace(entry: SavedPlace, status: ServerStatus | undefined, lends: boolean): Device {
  const hand = byHand(entry);
  // A Cloud this app is connected to right now is online; nothing else about it is checked from here.
  const state = hand ? placeState(status) : status?.state === "connected" ? { status: "online" as const } : { status: "unknown" as const };
  const route = placeRoute(entry);
  const actions: DeviceAction[] = [{ type: "switch", placeId: entry.id }];
  if (hand && entry.origin) {
    if (state.note === "unreachable") actions.push({ type: "retry", placeId: entry.id });
    if (state.note === "update") actions.push({ type: "copy-update", install: status?.install ?? null });
    // One way back per case: Try again while it can't be reached, Pair again only once its sign-in is gone or unsafe.
    if (state.note === "signed-out" || state.note === "insecure") actions.push({ type: "pair-again", placeId: entry.id, address: entry.origin });
    actions.push({ type: "copy-address", address: entry.origin });
  }
  if (!entry.home) actions.push({ type: "remove", source: { type: "place", id: entry.id } });
  return {
    id: `place:${entry.id}`, kind: entry.home || entry.cloud ? "cloud" : MINI_LABEL.test(entry.name) ? "desktop" : "server", name: entry.name, ...state, route, routes: [route],
    ...(hand && status?.version ? { version: status.version } : {}), ...(hand && entry.origin ? { address: entry.origin } : {}),
    sources: [{ type: "place", id: entry.id }], canRunBots: true, canHostComputer: false, ...(entry.home ? { home: true as const } : {}),
    ...(lends ? { usesThisComputer: true } : {}), ...(state.status === "online" ? { live: true as const } : {}), actions,
  };
}

/** The ways a phone may use to reach this computer right now; null where the phone link doesn't say (an older build). */
function phoneWays(device: PhoneDevice, routes: CompanionState["routes"] | undefined): DeviceRoute[] | null {
  if (!routes) return null;
  const anywhere = device.routes !== "local";
  return [
    ...(anywhere && routes.relay?.on ? ["relay" as const] : []),
    ...(routes.wifi?.on ? ["local" as const] : []),
    ...(routes.tailscale?.on ? ["tailscale" as const] : []),
    ...(anywhere && routes.https?.on ? ["internet" as const] : []),
  ];
}

const RECORDED: Record<NonNullable<PhoneDevice["route"]>, DeviceRoute> = { wifi: "local", tailscale: "tailscale", relay: "relay" };

function fromPhone(device: PhoneDevice, connected: ReadonlySet<string>, routes: CompanionState["routes"] | undefined): Device {
  const ways = phoneWays(device, routes);
  const recorded = device.route ? RECORDED[device.route] : null;
  const route = recorded && (!ways || ways.includes(recorded)) ? recorded : ways?.[0] ?? "local";
  const closed = ways?.length === 0 && !Object.values(routes ?? {}).some((way) => way.on);
  const now = !closed && (connected.has(device.id) || Boolean(device.route));
  return {
    id: `phone:${device.id}`, kind: "phone", name: device.name, status: closed ? "attention" : now ? "online" : "offline", ...(closed ? { note: "no-way-in" as const } : {}),
    ...(now ? { live: true as const } : {}), route, routes: ways?.length === 0 ? [] : [route], lastSeen: device.lastSeenAt, sources: [{ type: "phone", id: device.id }],
    canRunBots: false, canHostComputer: false,
    actions: [...(closed ? [{ type: "turn-on-way" as const }] : []), { type: "remove", source: { type: "phone", id: device.id } }],
  };
}

function fromPhoneApp(phone: PublicPhone): Device {
  return {
    id: `phone-app:${phone.key}`, kind: "phone", name: phone.registration.name, status: phone.online ? "online" : "offline", ...(phone.online ? { live: true as const } : {}),
    route: "paired", routes: ["paired"],
    lastSeen: phone.seen, version: phone.registration.appVersion, sources: [{ type: "phone-app", id: phone.key }], canRunBots: false, canHostComputer: false,
    actions: [{ type: "remove", source: { type: "phone-app", id: phone.key } }],
  };
}

function fromSession(session: SignedInDevice, route: DeviceRoute, now: number): Device {
  const name = session.person ? `${session.person} · ${session.label}` : session.label;
  return {
    id: `session:${session.id}`, kind: kindFromLabel(session.label), name, status: now - session.lastSeenAt < SESSION_ONLINE_MS ? "online" : "offline",
    route, routes: [route], lastSeen: session.lastSeenAt, sources: [{ type: "session", id: session.id }], canRunBots: false, canHostComputer: false,
    access: session.scopes.includes("admin") ? "full" : "chat", ...(session.email && session.email !== session.person ? { email: session.email } : {}),
    actions: [{ type: "remove", source: { type: "session", id: session.id } }],
  };
}

function fromLent(computer: LentDevice, route: DeviceRoute): Device {
  return {
    id: `lent:${computer.id}`, kind: "laptop", name: computer.name, status: computer.online ? "online" : "offline", ...(computer.online ? { live: true as const } : {}), route, routes: [route],
    lastSeen: computer.lastSeenAt, sources: [{ type: "lent", id: computer.id }], canRunBots: false, canHostComputer: true, actions: [],
  };
}

function fromVps({ alias, name }: { alias: string; name?: string }): Device {
  return {
    id: vpsServerId(alias), kind: "server", name: name?.trim() || alias, status: "unknown", route: "ssh", routes: ["ssh"], sources: [{ type: "vps", id: alias }],
    canRunBots: false, canHostComputer: true, actions: [],
  };
}

/** Joined sources keep the one that needs the person first, then the one that is online. */
const STATUS_RANK: Record<DeviceStatus, number> = { attention: 4, online: 3, offline: 1, unknown: 0 };
const isComputer = (kind: DeviceKind) => kind !== "phone";

/** One machine two sources both list: the first keeps its id and kind; routes, sources and actions join. */
function join(into: Device, other: Device): Device {
  const status = STATUS_RANK[other.status] > STATUS_RANK[into.status] ? other.status : into.status;
  const seen = Math.max(into.lastSeen ?? 0, other.lastSeen ?? 0);
  return {
    ...into, status, note: status === into.status ? into.note : other.note, routes: [...new Set([...into.routes, ...other.routes])],
    ...(into.live || other.live ? { live: true as const } : {}),
    ...(seen ? { lastSeen: seen } : {}), version: into.version ?? other.version, address: into.address ?? other.address,
    sources: [...into.sources, ...other.sources], canRunBots: into.canRunBots || other.canRunBots, canHostComputer: into.canHostComputer || other.canHostComputer,
    actions: [...into.actions, ...other.actions.filter((action) => action.type === "remove" || !into.actions.some((mine) => mine.type === action.type))],
  };
}

/** Merges the device lists in order of how much each knows. A later device joins an earlier one only when it is the
 * same sort (a phone with a phone, a computer with a computer), from another source, and the name they share is
 * unique on both sides: two "Chrome on Mac" sessions stay two devices. */
function mergeAll(lists: Device[][], aliases: ReadonlyMap<string, string[]>): Device[] {
  const out: Device[] = [];
  const keysOf = (device: Device) => [nameKey(device.name), ...(aliases.get(device.id) ?? [])].filter(Boolean);
  const count = new Map<string, number>();
  for (const device of lists.flat()) {
    for (const key of new Set(keysOf(device))) count.set(`${device.sources[0]!.type}|${key}`, (count.get(`${device.sources[0]!.type}|${key}`) ?? 0) + 1);
  }
  const unique = (device: Device, key: string) => count.get(`${device.sources[0]!.type}|${key}`) === 1;
  for (const list of lists) {
    for (const device of list) {
      const keys = keysOf(device).filter((key) => unique(device, key));
      const at = out.findIndex((known) => isComputer(known.kind) === isComputer(device.kind)
        && !known.sources.some((source) => source.type === device.sources[0]!.type)
        && keysOf(known).some((key) => keys.includes(key) && unique(known, key)));
      if (at < 0) out.push(device);
      else out[at] = join(out[at]!, device);
    }
  }
  return out;
}

/** Every device the sources know, this place first. */
export function buildDevices(sources: DeviceSources): Device[] {
  const now = sources.now ?? Date.now();
  const { here } = sources;
  const self: Device = {
    id: "here", kind: here.kind === "computer" ? "laptop" : here.kind === "server" ? "server" : "cloud", name: here.name, status: "online", route: "here", routes: ["here"],
    ...(here.version ? { version: here.version } : {}), sources: [], canRunBots: true, canHostComputer: here.kind === "computer" && here.desktop, here: true, actions: [],
  };
  const statuses = sources.statuses ?? [];
  const aliases = new Map<string, string[]>();
  const places = (sources.places?.environments ?? [])
    .filter((entry) => entry.kind !== "local" && entry.id !== "local" && entry.id !== sources.places?.activeId)
    .map((entry) => {
      const device = fromPlace(entry, statuses.find((status) => status.id === entry.id), (sources.lending ?? []).some((lent) => lent.id === entry.id && lent.enabled));
      const host = entry.origin && byHand(entry) ? hostKey(entry.origin) : null;
      if (host) aliases.set(device.id, [host]);
      return device;
    });
  const connected = new Set(sources.companion?.connectedDeviceIds ?? []);
  const phones = (sources.companion?.devices ?? []).map((device) => fromPhone(device, connected, sources.companion?.routes));
  const apps = (sources.phoneApps ?? []).map(fromPhoneApp);
  const remote: DeviceRoute = here.kind === "computer" ? (sources.companion?.routes?.tailscale?.on ? "tailscale" : "local") : here.kind === "server" ? "internet" : "cloud";
  // A Cloud lists only the devices that can manage it: its chat-only sessions are teammates' (ServerPairingCard's rule).
  const signedIn = (sources.sessions?.sessions ?? [])
    .filter((session) => session.id !== sources.sessions?.current && !session.token && (here.kind === "computer" || here.kind === "server" || session.scopes.includes("admin")))
    .map((session) => fromSession(session, remote, now));
  const lent = (sources.lent ?? []).filter((computer) => computer.lent).map((computer) => fromLent(computer, here.kind === "computer" || here.kind === "server" ? "paired" : "cloud"));
  const vps = (sources.vps ?? []).filter((server, index, all) => server.alias && all.findIndex((other) => other.alias === server.alias) === index).map(fromVps);
  return [self, ...mergeAll([places, lent, phones, apps, signedIn, vps], aliases)];
}

/** The private network as the map draws it. `unknown`: not asked yet, since the app asks Tailscale only when told to. */
export type PrivateNetworkState = "unknown" | "not-installed" | "no-cli" | "signed-out" | "not-running" | "needs-approval" | "needs-permission" | "magicdns" | "ready";

export interface PrivateNetwork {
  state: PrivateNetworkState;
  /** This computer's name on it, once ready. */
  name: string | null;
  /** Other computers on it may open this one (Your other computers is on). */
  shared: boolean;
}

/** `problem`: the reason the last Turn on or Check again gave, which only that answer carries. */
export function privateNetwork(companion: Pick<CompanionState, "routes" | "tailnetShare"> | null | undefined, problem: CompanionState["tailscaleProblem"] | null): PrivateNetwork | null {
  if (!companion) return null;
  const route = companion.routes?.tailscale;
  const shared = route?.on === true && route.computers === true;
  if (problem) return { state: problem, name: null, shared };
  if (!route?.on) return { state: "unknown", name: null, shared: false };
  if (!route.name) return { state: "magicdns", name: null, shared };
  return { state: "ready", name: route.name, shared };
}

/** The map's groups, by what a person calls each device. */
export type DeviceGroup = "computers" | "servers" | "phones";
export const GROUP_ORDER: readonly DeviceGroup[] = ["phones", "computers", "servers"];
export const deviceGroup = (device: Device): DeviceGroup =>
  device.kind === "phone" ? "phones" : device.kind === "laptop" || device.kind === "desktop" ? "computers" : "servers";

/** The groups around this place, in a fixed order; empty groups are left out unless `all` asks for them. */
export function groupByKind(devices: readonly Device[], { all = false }: { all?: boolean } = {}): Array<{ group: DeviceGroup; devices: Device[] }> {
  return GROUP_ORDER.map((group) => ({ group, devices: devices.filter((device) => !device.here && deviceGroup(device) === group) }))
    .filter((entry) => all || entry.devices.length > 0);
}
