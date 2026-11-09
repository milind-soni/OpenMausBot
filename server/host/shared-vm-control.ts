import { viewerTargetId } from "../../shared/desktop-viewer.ts";
import type { ComputerControl, ControlSnapshot } from "../computer-control.ts";
import { SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget, type LocalVmTarget } from "../container-computer.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import type { Surface } from "../surface.ts";
import { teamComputerOwner } from "../team-computers.ts";

/** A person's hold on the one shared Local VM. Bot ids match [\w-]+, so no bot's own key can equal it. */
export const SHARED_VM_CONTROL_KEY = "desktop:local/shared";
const SHARED_VM_RESOURCE = `computer:vm:${SHARED_LOCAL_VM_TARGET.key}`;
const SHARED_VM_VIEWER = viewerTargetId(SHARED_LOCAL_VM_TARGET);

export interface SharedVmControlDeps {
  control: Pick<ComputerControl, "snapshot" | "release" | "releaseLease" | "ownsLease" | "heldBy" | "beat" | "forgetBot">;
  store: { readonly bots: BotRecord[]; bot(id: string): BotRecord | null; tasks(botId: string): ReadonlyArray<{ threadId: string; surface?: string }> };
  /** The Local VM mode; null in a Cloud home, which has no Local VM. */
  mode(): "shared" | "per-bot" | "pool" | null;
  /** The bot a conversation runs with: its running turn's settings, else the stored bot. */
  botForThread(botId: string, threadId: string): BotRecord | null;
  /** The settings each running direct turn uses, by conversation. */
  turnBots: Pick<ReadonlyMap<string, BotRecord>, "entries">;
  /** The team cloud computer each conversation's running turn holds, by conversation. */
  teamTurns: Pick<ReadonlyMap<string, { computerId: string; botId: string }>, "get" | "values">;
  /** The id of the team cloud computer the bot inherits. */
  teamComputer(bot: BotRecord): string | undefined;
  /** The computer a conversation works on, person- or auto-pinned; undefined while Auto has not chosen. */
  place(bot: BotRecord, threadId: string): string | undefined;
  /** The Local VM each conversation's running turn works on, by conversation. */
  turnVmTargets: Pick<ReadonlyMap<string, LocalVmTarget>, "get">;
  /** True while the shared VM's image, container or isolation mode is being changed. */
  busy(): boolean;
}

/** Where a person's hold on a bot's computer lives, and what reads it: one key resolution for every person's path. */
export function createSharedVmControl(deps: SharedVmControlDeps) {
  const { control, store } = deps;

  const sharedDesk = (): boolean => deps.mode() === "shared";
  /** Whether a conversation works on a Local VM: its chosen place; while Auto has not chosen, the shared VM its running
   * turn is on, else the bot's default, where an Auto bot with a VPS works on the VPS. */
  const onLocalVm = (bot: BotRecord, threadId?: string): boolean => {
    const place = threadId ? deps.place(bot, threadId) : undefined;
    if (place !== undefined) return place === "vm";
    if (threadId && deps.turnVmTargets.get(threadId)?.key === SHARED_LOCAL_VM_TARGET.key) return true;
    return bot.computer === "vm" || (bot.computer === undefined && bot.cloudBackend !== "vps");
  };
  /** The team cloud computer a conversation's hold lands on: its running team turn's, else the one the bot inherits. */
  const teamKey = (bot: BotRecord, threadId?: string): string | undefined => {
    const team = threadId ? deps.teamTurns.get(threadId) : undefined;
    if (team?.botId === bot.id) return teamComputerOwner(team.computerId);
    const inherited = deps.teamComputer(bot);
    return inherited ? teamComputerOwner(inherited) : undefined;
  };
  /** The team's cloud computer, the shared Local VM, or the bot's own key. Without a conversation it follows the bot's
   * default place. */
  const keyFor = (bot: BotRecord, threadId?: string): string =>
    teamKey(bot, threadId) ?? (sharedDesk() && onLocalVm(bot, threadId) ? SHARED_VM_CONTROL_KEY : bot.id);

  /** Its own key first, then every key a take through its panels or a gate of its turns can land on, so no panel is told less
   * than its own hold; read from stored pins (Off overrides them), as every broadcast asks it of every bot. */
  const botKeys = (bot: BotRecord): string[] => {
    const keys = [bot.id, keyFor(bot)];
    for (const [threadId, turnBot] of deps.turnBots.entries()) if (turnBot.id === bot.id) keys.push(keyFor(turnBot, threadId), keyFor(turnBot));
    for (const turn of deps.teamTurns.values()) if (turn.botId === bot.id) keys.push(teamComputerOwner(turn.computerId));
    if (sharedDesk() && !deps.teamComputer(bot) && bot.computer !== "off" &&
      store.tasks(bot.id).some(task => task.surface === "vm" || (task.surface === undefined && bot.computer === undefined))) keys.push(SHARED_VM_CONTROL_KEY);
    return [...new Set(keys)];
  };

  /** Held if any key is held, with the first sign-in plea on any of them, so a hold on one computer never hides a plea on another. */
  const merged = (keys: string[]): ControlSnapshot => {
    const snapshots = keys.map(key => control.snapshot(key));
    const held = snapshots.find(snapshot => snapshot.held);
    const pleading = snapshots.find(snapshot => snapshot.helpReason !== null);
    if (!held) return pleading ?? snapshots[0]!;
    return held.helpReason !== null || !pleading ? held : { ...held, helpReason: pleading.helpReason, ...(pleading.help ? { help: pleading.help } : {}) };
  };

  /** A hold taken without a conversation pauses every conversation of the bot, as a hold on its own key does; a turn still
   * on the shared VM waits for its hold whatever its bot is set to now. */
  const snapshot = (botId: string, threadId?: string): ControlSnapshot => {
    const bot = threadId ? deps.botForThread(botId, threadId) : store.bot(botId);
    const mounted = threadId && sharedDesk() && deps.turnVmTargets.get(threadId)?.key === SHARED_LOCAL_VM_TARGET.key ? [SHARED_VM_CONTROL_KEY] : [];
    return merged([...new Set([botId, ...(bot ? [keyFor(bot, threadId), keyFor(bot)] : []), ...mounted])]);
  };

  /** What a bot's panels and the bot list are told: the first of its keys held, else the first pleading, else its own. */
  const botSnapshot = (botId: string): ControlSnapshot => {
    const bot = store.bot(botId);
    return bot ? merged(botKeys(bot)) : control.snapshot(botId);
  };

  /** A team cloud computer or the shared Local VM serves several bots, so one bot's sign-in card must not hand it back
   * from under another. */
  const sharedKey = (key: string): boolean => key === SHARED_VM_CONTROL_KEY || key.startsWith(teamComputerOwner(""));
  /** Outside shared mode no bot's keys name the shared desktop, yet panels paused on it before the change must hear it ended. */
  const membersOf = (key: string): string[] => key === SHARED_VM_CONTROL_KEY && !sharedDesk() ? store.bots.map(bot => bot.id)
    : sharedKey(key) ? store.bots.filter(bot => botKeys(bot).includes(key)).map(bot => bot.id) : [key];

  const personHolds = (resource: string): boolean => resource === SHARED_VM_RESOURCE && control.snapshot(SHARED_VM_CONTROL_KEY).held;

  /** The hold this lease owns: the key a take resolved may differ now, as places, pins and team turns change. */
  const leaseHolder = (bot: BotRecord, threadId: string | undefined, lease: string): string => {
    const key = keyFor(bot, threadId);
    return control.ownsLease(key, lease) ? key : control.heldBy(lease) ?? key;
  };

  return {
    keyFor,
    /** The key a take or a hand-back without a lease holds: the desktop a panel names, else the conversation's own. Only the
     * shared VM names more than the bot's own key, so only it is checked: null when this conversation cannot show it. */
    holdKey: (bot: BotRecord, threadId: string | undefined, target?: string): string | null => {
      if (target === undefined) return keyFor(bot, threadId);
      if (target !== SHARED_VM_VIEWER) return bot.id;
      if (!threadId) return keyFor(bot) === SHARED_VM_CONTROL_KEY ? SHARED_VM_CONTROL_KEY : null;
      const place = deps.place(bot, threadId);
      return sharedDesk() && !teamKey(bot, threadId) && (place === undefined || place === "vm") ? SHARED_VM_CONTROL_KEY : null;
    },
    snapshot,
    /** The bots told about a change on this key. */
    membersOf,
    botSnapshot,
    /** Deleting a bot a person's hold reaches would leave that hold to panels that may no longer exist. */
    deletionRefusal: (botId: string): string | null =>
      botSnapshot(botId).held ? "Hand back control of this bot's computer before deleting it" : null,
    /** The key a phone's lease must own to open this conversation's Local VM: the shared desktop's in shared mode. */
    leaseKey: (bot: BotRecord, threadId?: string): string => sharedDesk() ? SHARED_VM_CONTROL_KEY : keyFor(bot, threadId),
    heldOnTarget: (target: LocalVmTarget): boolean => {
      if (target.key === SHARED_LOCAL_VM_TARGET.key) return control.snapshot(SHARED_VM_CONTROL_KEY).held;
      return store.bots.some(bot => perBotLocalVmTarget(bot.id).key === target.key && control.snapshot(bot.id).held);
    },
    /** True while a person holds the shared VM this turn resource names. */
    personHolds,
    sharedKey,
    signInKey: (bot: BotRecord, threadId: string, place: Surface): string => place === "browser" ? bot.id : keyFor(bot, threadId),
    keyMovesWhileHeld: (before: BotRecord, after: BotRecord): boolean =>
      keyFor(before) !== keyFor(after) && snapshot(before.id).held,
    takeRefusal: (key: string): string | null =>
      key === SHARED_VM_CONTROL_KEY && deps.busy() ? "The Local VM is being updated or changed — wait before taking control" : null,
    /** A phone's take of a Local VM starts the expiry clock at once: nothing else may ever beat for it. A take naming a VPS
     * desktop is not one, though it lands on the key a per-bot VM shares. */
    armed: (auth: RequestAuth, bot: BotRecord, threadId: string | undefined, key: string, target?: string): boolean => {
      const phone = auth.kind === "loopback" ? Boolean(auth.companionDevice) : auth.via === "bearer";
      return phone && !(target?.startsWith("vps/") && bot.cloudBackend === "vps") && (key === SHARED_VM_CONTROL_KEY ||
        (key === bot.id && deps.mode() === "per-bot" && onLocalVm(bot, threadId)));
    },
    release: (bot: BotRecord, threadId: string | undefined, lease: string) =>
      control.releaseLease(leaseHolder(bot, threadId, lease), lease),
    check: (bot: BotRecord, threadId: string | undefined, lease: string) => {
      const key = leaseHolder(bot, threadId, lease);
      return { ...control.snapshot(key), owned: control.beat(key, lease) };
    },
    /** Ends the bot's pleas once the bot is gone; a deletion that was cancelled leaves them. */
    botDeleted: (botId: string): void => {
      if (!store.bot(botId)) control.forgetBot(botId);
    },
    /** Called before a Local VM mode change is saved; the returned call, once it is, ends the holds no path reads any more. */
    modeChanging: (): (() => void) => {
      const before = new Map(store.bots.map(bot => [bot.id, keyFor(bot)]));
      return () => {
        for (const bot of store.bots) if (before.has(bot.id) && before.get(bot.id) !== keyFor(bot)) control.release(before.get(bot.id)!);
        control.release(SHARED_VM_CONTROL_KEY);
      };
    },
  };
}
