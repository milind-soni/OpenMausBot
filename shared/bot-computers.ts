/** Where a bot works. `cloud`: a cloud desktop, the bot's own or its team's. `vps`: a desktop container on a server the
 * person reaches over SSH. `vm`: a Local VM. `local`: this computer. `browser`: the built-in browser alone. `off`: no
 * screen at all. `auto`: Auto picks a place per turn. */
export type BotComputerKind = "cloud" | "vps" | "vm" | "local" | "browser" | "off" | "auto";

/** The last state this server already knew, never a fresh look. `none`: the last look found no computer. `unknown`:
 * nothing this server holds says. */
export type BotComputerState = "ready" | "asleep" | "starting" | "unreachable" | "none" | "unknown";

/** One line from a bot to the computer it works on: the bot's own place, or a chat's place when that chat has its own. */
export interface BotComputerRow {
  botId: string;
  /** Present on a chat whose place differs from its bot's. */
  threadId?: string;
  kind: BotComputerKind;
  /** On `auto`: the place Auto would use, when the server can tell without looking at any computer. The fields below then
   * describe that place. */
  autoKind?: Exclude<BotComputerKind, "auto">;
  /** Stable across reads and the same for every bot sharing one computer: `cloud:<owner>` (a bot id, or a team computer's
   * owner key), `vps:<alias>/<container>`, `vm:<target>`, `local`. Null for `browser`, `off` and an unresolved `auto`. */
  computerId: string | null;
  /** A name the person gave it (a team computer, a named VPS server, this computer); null: call it by its kind. */
  name: string | null;
  state: BotComputerState;
  /** Epoch ms of the reading `state` comes from; null when that reading has no time. */
  stateAt: number | null;
  /** A team's shared cloud desktop: its id in `/api/team-computers`. */
  teamComputerId?: string;
  /** The cloud desktop's provider id, when this server holds it. */
  boxId?: string;
  /** A VPS computer is always one container on its server: `serverId` is `vps:<alias>`, the server's own device id. */
  vps?: { serverId: string; alias: string; container: string };
}

/** GET /api/computers/bots. `now` is the server's clock, for the age of each state. */
export interface BotComputersPayload {
  now: number;
  rows: BotComputerRow[];
}

/** A VPS server's device id, as `vps.serverId` and the Devices page carry it. */
export function vpsServerId(alias: string): string {
  return `vps:${alias}`;
}

/** The SSH alias in a `vps:<alias>` server id; null for any other id, a `vps:<alias>/<container>` computer id included. */
export function vpsAliasOfServerId(id: string): string | null {
  return /^vps:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.exec(id)?.[1] ?? null;
}
