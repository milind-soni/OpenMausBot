// Work that reaches a computer over the link from its Cloud follows the grant the person already made for their Clouds on
// this computer: "Let Clouds run commands on this computer" (the OpenMausBot icon's menu, off until they confirm it).
// While it is off, such work runs with no shell, no computer use, no reads outside the bot's working folders and no
// writes outside its working folder; nothing asks the person, and the bot is told why in one line. While it is on, the work
// runs at the bot's own level, as before. Work the person starts here, a Cloud's own work and work going to the Cloud
// are never limited here.
//
// Security: whether work came from the far side is read from the coordinator's own record, never from what the hand-off
// says: only link.ts start(), for a frame its authenticated session carried, opens a root named `link-<hand-off id>`, and
// everything handed on under that root keeps it. Engines that cannot run a turn without their shell (no guestTurns:
// "confined") refuse such work with a line back to the sender, rather than run it at the bot's own level.
import { randomUUID } from "node:crypto";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import { isConnectedAppsServer } from "../../shared/own-apps.ts";
import type { SendTurnInput } from "../contracts.ts";
import { outsideRouteRefused } from "../host/outside-fence.ts";
import { LINK_PREFIX } from "./protocol.ts";

/** What the bot is told, and how a refusal ends. */
export const LINK_COMMANDS_OFF = "Running commands on this computer is off for work from My Cloud, so this work runs here without a shell, computer use, or writes outside this work's own folder. If it needs them, say so plainly: the person can turn on \"Let Clouds run commands on this computer\" from the OpenMausBot icon.";
/** Said back to the sender when this bot's engine cannot be kept from running commands. */
export const LINK_ENGINE_REFUSAL = "This bot's AI can't work on this computer without running commands, and running commands on this computer is off for work from My Cloud, so this was not started. The person can turn on \"Let Clouds run commands on this computer\" from the OpenMausBot icon, or give this bot an AI that can work without them.";
/** An action such work asked for that it may not take. */
export const LINK_ACTION_DENIED = "Not allowed for work from My Cloud while running commands on this computer is off.";
/** Told to a Codex bot as well: it reads files only through its shell. */
export const LINK_CODEX_NO_FILES = "This bot's AI reads files only through its shell, so it can't read any files here: work from what you were sent, and say so in your answer.";
/** A connected app's action that changes something, refused to such work. */
export const LINK_APP_WRITE_REFUSAL = "Work from My Cloud can only read from connected apps on this computer while running commands here is off: this action would change something, so it was not done. Say plainly what the person would need to do.";
/** A harness route such work may not use. */
export const LINK_ROUTE_REFUSAL = "Work from My Cloud can't do that on this computer while running commands here is off: it may not change settings, add tools, or start or schedule work outside this conversation. Finish what you can here and say plainly what the person would need to do.";
/** The desktop's word on the grant, over Electron's private parent port (electron/link-commands-fact.mjs). */
export const LINK_COMMANDS_MESSAGE = "openmausbot:link-commands";

/** The integrations such a turn never gets: this computer's screen and apps, the browser (it opens file: and the person's
 * own Chrome), the paired phones, the person's own MCP servers (commands run here), and the Data tools (their SQL reads
 * and writes files). The harness's own team tools, connected apps, email and hooks stay. */
const NOT_LENT = ["localComputer", "browser", "phone", "device", "custom", "mcpApps", "customResultBudgets", "data", "dweb"] as const;

/** Of the routes a confined turn may reach (host/outside-fence.ts), the ones that would change this computer's setup or
 * start work later outside this conversation's lineage, where it would run at a bot's own level; memory writes, which later
 * turns there obey; and the integrations' own routes, which such a turn is never given. Handing work on stays: it keeps
 * the lineage. */
const LATER_OR_SETUP: ReadonlySet<string> = new Set([
  "POST /api/internal/threads", "POST /api/internal/post-to-room", "POST /api/internal/retry-thread", "POST /api/internal/trigger-requests",
  "POST /api/internal/manage-room", "POST /api/internal/waits", "POST /api/internal/profile-requests", "POST /api/internal/model-requests",
  "POST /api/internal/team-setup-requests", "POST /api/internal/bot-deletion-requests", "POST /api/internal/create-bot",
  "POST /api/internal/skills/stage", "POST /api/internal/mcp-servers", "POST /api/internal/shared-computers", "POST /api/internal/connectors/request",
  "POST /api/internal/browser/mcp", "POST /api/internal/computer/mcp", "GET /api/internal/computer-control", "POST /api/internal/computer-control",
  "POST /api/internal/computer/journal", "POST /api/internal/data/mcp",
  "POST /api/internal/memory", "POST /api/internal/memory/log", "POST /api/internal/team-memory",
]);

/** Whether a limited turn's connected-app calls include one that changes something: every app counts as read-only. */
export function linkAppWriteRefused(calls: ReadonlyArray<{ slug: string; account?: string }>, toolkits: readonly string[]): boolean {
  return !connectorAccessDecision({ apps: Object.fromEntries(toolkits.map((toolkit) => [toolkit.toLowerCase(), "read" as const])) }, [...calls], toolkits).ok;
}

/** What a limited turn's coordinate_bots call may not do, whatever the bot it names: answer for the person a question that
 * waits outside this work (`forPerson`: never tried), answer work outside this work's lineage, or leave words in another
 * conversation that its next run, at that bot's own level, would read. A refusal, or null. */
export function linkHandOnRefusal(call: { answers?: string; post?: { wake: boolean } }, farSide: (nodeId: string) => boolean): string | null {
  if (call.answers !== undefined && !farSide(call.answers)) return LINK_ROUTE_REFUSAL;
  if (call.post && !call.post.wake) return LINK_ROUTE_REFUSAL;
  return null;
}

/** Whether a limited turn is refused this harness route: every route a confined turn is, and LATER_OR_SETUP. */
export function linkRouteRefused(method: string, path: string): boolean {
  return outsideRouteRefused(method, path) || LATER_OR_SETUP.has(`${method.toUpperCase()} ${path}`);
}

export interface LinkLimitsDeps {
  /** This server is a Cloud, or the side of the link that computers ask: work from a computer runs in its own place, so
   * nothing is limited here. Asked each time, since the link can be turned on or off. */
  cloud(): boolean;
  node(id: string): { rootId: string } | undefined;
  /** Whether this bot's engine runs a turn without its shell (its guestTurns is "confined"). */
  confinable(bot: { id: string }): boolean;
}

/** Whether coordinated work traces to the far side: its root is one link.ts opened for a hand-off it took. */
export function fromFarSide(nodeId: string | undefined, node: LinkLimitsDeps["node"]): boolean {
  if (!nodeId) return false;
  const rootId = node(nodeId)?.rootId ?? nodeId;
  return rootId.startsWith(LINK_PREFIX);
}

/** The level a limited turn runs at: writes in the working folder only, never Full. Claude: Auto-accept edits (anything
 * outside asks, and is refused here). Codex: Ask, which is workspace-write with the shell off. An API model has no files
 * or shell once this computer's tools are gone, so it keeps its level for its connected apps. Ask stays Ask. */
export function linkLevel(own: ApprovalMode, driverKind: string | undefined): ApprovalMode {
  if (own === "ask") return "ask";
  if (driverKind === "claudeAgent") return "edits";
  if (driverKind === "codex") return "ask";
  return own;
}

/** A tool of the connected apps or Email, whose own routes refuse such work anything but reads (linkAppWriteRefused,
 * the Email host's read-only mode): so the engine's ask for it is answered at the bot's own level. */
const readsOnlyHere = (tool: string | undefined): boolean => {
  const server = tool?.startsWith("mcp__") ? tool.split("__")[1] ?? "" : "";
  return isConnectedAppsServer(server) || server === "email";
};

export function createLinkLimits(deps: LinkLimitsDeps) {
  let commandsLent = false;
  /** The conversations a limited turn runs in now, with its engine kind. */
  const running = new Map<string, string | undefined>();
  const off = () => !commandsLent && !deps.cloud();

  return {
    /** This coordinated turn is work from the far side, and running commands is not lent: it runs limited. */
    limited: (nodeId: string | undefined): boolean => off() && fromFarSide(nodeId, deps.node),
    /** Work started here by what the far side wrote (a far member's answer in a room here) runs limited while commands are off. */
    commandsOff: (): boolean => off(),
    /** Whether coordinated work traces to the far side, grant or not. */
    farSide: (nodeId: string): boolean => fromFarSide(nodeId, deps.node),
    /** The root id for a turn started by what the far side wrote: everything handed on under it is known as the far side's. */
    farRoot: (): ReturnType<typeof randomUUID> => `${LINK_PREFIX}here-${randomUUID()}`,
    /** At accept: why this bot cannot take work from the far side now (its engine always has a shell), or null. */
    acceptRefusal: (bot: { id: string }): string | null => (off() && !deps.confinable(bot) ? LINK_ENGINE_REFUSAL : null),
    /** The turn's input as its engine gets it. Unlimited: the same object, untouched. */
    input<T extends SendTurnInput>(limited: boolean, instance: { driverKind?: string }, turn: T): T {
      if (!limited) return turn;
      const { botSettingsFile: _settings, mcpFromUserConfig: _userMcp, preloadBrowserTools: _browser, approvalModeNow, ...rest } = turn;
      const integrations = turn.integrations ? { ...turn.integrations } : undefined;
      for (const key of NOT_LENT) if (integrations) delete integrations[key];
      const kind = instance.driverKind, told = kind === "codex" ? `${LINK_COMMANDS_OFF} ${LINK_CODEX_NO_FILES}` : LINK_COMMANDS_OFF;
      return {
        ...rest, linkLimited: true, confinedWhy: LINK_COMMANDS_OFF,
        text: `${turn.text}\n\n${told}`,
        ...(turn.recoveryText !== undefined ? { recoveryText: `${turn.recoveryText}\n\n${told}` } : {}),
        approvalMode: linkLevel(turn.approvalMode ?? "full", kind),
        ...(approvalModeNow ? { approvalModeNow: () => linkLevel(approvalModeNow(), kind) } : {}),
        ...(integrations ? { integrations } : {}),
      } as T;
    },
    /** A turn starts in this conversation: limited (with its engine kind) or not. */
    begin(threadId: string, limited: boolean, driverKind: string | undefined): void {
      if (limited) running.set(threadId, driverKind); else running.delete(threadId);
    },
    /** The limited turn running in this conversation, if any: what its permission requests are answered at. */
    held(threadId: string): { level(own: ApprovalMode, tool?: string): ApprovalMode } | null {
      if (!running.has(threadId)) return null;
      const kind = running.get(threadId);
      return { level: (own, tool) => (readsOnlyHere(tool) ? own : linkLevel(own, kind)) };
    },
    /** The desktop said whether every Cloud of the person's own may run commands here. True when the message was this. */
    receive(message: unknown): boolean {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== LINK_COMMANDS_MESSAGE) return false;
      commandsLent = (message as { on?: unknown }).on === true;
      return true;
    },
    commandsLent: () => commandsLent,
  };
}

export type LinkLimits = ReturnType<typeof createLinkLimits>;
