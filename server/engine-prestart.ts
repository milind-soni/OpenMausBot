// Starting a new conversation's engine before its first message. An engine process is launched for one conversation
// (its folder, its session and its bearers are in the launch), so nothing can be kept spare for whichever comes next.
// What can be known ahead is the launch the bot's last conversation used: a new conversation on the same bot, with the
// same model, approval level and folder rule, launches the same way but for its own id and its own bearers. This file
// keeps that last launch per bot, rewrites it for the new conversation and asks the driver to start it. The driver takes
// the process for the first turn only when that turn's own launch comes out identical, and replaces it otherwise
// so a wrong guess costs a process that was never used, never a wrong one that was.
//
// A conversation that already has messages starts the same way when a person opens it or types in it: the bot's last
// launch, for this conversation, resuming the engine session its next turn would resume. Its bearers are its own and stay
// when that engine goes unused, since its next turn launches with them.
//
// Not started ahead: a bot's very first conversation (no launch to go by), a launch that mounts anything beyond
// OpenMausBot's own tool servers (a person's MCP servers, connected apps, a browser or a computer would be started
// early), a guest's or tool-scoped turn, and any host where engines wait for memory or memory is short.
import { randomBytes } from "node:crypto";

import type { ProviderAdapter, SendTurnInput } from "./contracts.ts";
import { OPENED_PRESTART_IDLE_MS, PRESTART_IDLE_MS, PRESTART_MOST } from "./drivers/session-idle.ts";

/** Each conversation's bearers: per slot, what the bearer grants and the bearer. */
export type SessionCredentials = Map<string, Map<string, { grants: string; token: string }>>;

/** The conversation's bearer for a slot: the one it holds while its grants stand, a new one otherwise. */
export function bearerForGrants(credentials: SessionCredentials, threadId: string, slot: string, grants: string): string {
  const slots = credentials.get(threadId) ?? new Map<string, { grants: string; token: string }>();
  credentials.set(threadId, slots);
  const held = slots.get(slot);
  if (held?.grants === grants) return held.token;
  const token = randomBytes(24).toString("hex");
  slots.set(slot, { grants, token });
  return token;
}

export interface EnginePrestartDeps {
  adapter(instanceId: string): Pick<ProviderAdapter, "prestart"> | undefined;
  credentials: SessionCredentials;
  /** The host starts engines ahead at all. */
  allowed(): boolean;
  /** Everything about a conversation that decides its launch besides its id: null when it is gone. Two conversations of
   * one bot with the same answer launch alike. */
  shape(botId: string, threadId: string): string | null;
  /** The approval level a bearer of this conversation is bound to, as its grants record it. */
  approval(botId: string, threadId: string): unknown;
  /** Makes the conversation's working folder as its first turn would (its skills in place), and says where it is: the
   * engine reads the folder as it starts. Null when the conversation has none of its own. */
  folder(botId: string, threadId: string): string | null;
  /** No message yet. */
  blank(threadId: string): boolean;
  /** A turn is being set up or running there. */
  busy(botId: string, threadId: string): boolean;
  /** A first message would be refused now (the bot is paused or held, at its limit, over budget, its AI signed out). */
  refused(botId: string, threadId: string): boolean;
  /** How long a started engine waits; the bearers made for it are retired a little after. */
  idleMs?: number;
  /** This server runs under the desktop app, for the person at that computer: only there does opening a conversation
   * start its engine. */
  desktop(): boolean;
  /** The bot whose conversation this is; null for anything else (a room). */
  botOf(threadId: string): string | null;
  /** The engine session this conversation's next turn on `instanceId` would resume, if it would resume one. */
  cursor(botId: string, threadId: string, instanceId: string): SendTurnInput["resumeCursor"];
  /** Wall-clock time: timers stand still while the machine sleeps. */
  now?: () => number;
}

interface Launch {
  instanceId: string;
  threadId: string;
  shape: string;
  /** The turn's input as JSON, without the message and without anything that resumes a session. */
  input: string;
  bearers: Array<{ slot: string; grants: string; token: string }>;
}

/** The tool servers OpenMausBot runs itself: starting them early starts nothing of the person's. */
const OWN_SERVERS = new Set(["agents", "phone", "data", "device", "email", "hooks", "custom", "customResultBudgets", "mcpApps"]);

function startsOnlyOwnServers(input: SendTurnInput): boolean {
  const mounted = input.integrations ?? {};
  return Object.keys(mounted).every((name) => OWN_SERVERS.has(name)) && Object.keys(mounted.custom ?? {}).length === 0
    && !input.guestConfined && !input.linkLimited && !input.mcpFromUserConfig && input.toolScope === undefined;
}

/** Nothing starts ahead for an archived bot or conversation, or on an engine whose last status read was signed out or
 * unavailable. */
export function prestartClosed(bot: { hidden?: boolean }, task: { archivedAt?: number } | null | undefined,
  engine: { authenticated?: boolean; state?: string } | null | undefined): boolean {
  return Boolean(bot.hidden) || task?.archivedAt !== undefined || engine?.authenticated === false || engine?.state === "unavailable";
}

const RELEASE_AFTER_MS = 5_000;
/** An open is acted on once the conversation stayed in front of the person this long, so clicking through conversations
 * starts nothing, and the switch itself never waits on the work. */
export const OPENED_SETTLE_MS = 1_000;
/** An opened conversation whose engine went unused is not started again this soon on the person's activity alone; typing
 * in its composer starts it again. */
export const OPENED_AGAIN_AFTER_MS = 15 * 60_000;
/** One launch per bot, for the bots a person wrote to most recently. */
const LAUNCHES_KEPT = 32;

export function createEnginePrestart(deps: EnginePrestartDeps) {
  const now = deps.now ?? Date.now;
  const launches = new Map<string, Launch>();
  /** Conversations given an engine ahead of any turn, until a turn uses it or it is retired. `opened`: one that had
   * messages already, whose bearers are its own. */
  const reserved = new Map<string, { botId: string; instanceId: string; timer: ReturnType<typeof setTimeout>; opened: boolean; at: number; waitMs: number }>();
  /** Opened conversations whose engine went unused, and when. */
  const unused = new Map<string, number>();
  let settling: { threadId: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const release = (threadId: string, retire: boolean) => {
    const held = reserved.get(threadId);
    if (!held) return;
    clearTimeout(held.timer);
    reserved.delete(threadId);
    if (!retire) return;
    deps.adapter(held.instanceId)?.prestart?.drop(threadId);
    if (!held.opened) deps.credentials.delete(threadId);
  };

  const bearerFor = (botId: string, threadId: string, slot: string, grantedElsewhere: string): string =>
    bearerForGrants(deps.credentials, threadId, slot, JSON.stringify({ ...JSON.parse(grantedElsewhere), threadId, approval: deps.approval(botId, threadId) }));

  /** Frees the places of engines that no longer wait (taken, closed, or past their wait by the wall clock: a sleep), then
   * when `opened` and still full, the place of the conversation opened longest ago. Whether one is free now. */
  const room = (opened: boolean): boolean => {
    for (const [other, held] of reserved) {
      const stale = now() - held.at > held.waitMs + RELEASE_AFTER_MS;
      if (stale || !deps.adapter(held.instanceId)?.prestart?.held(other)) release(other, !deps.busy(held.botId, other));
    }
    if (opened && reserved.size >= PRESTART_MOST) {
      const oldest = [...reserved].find(([other, held]) => held.opened && !deps.busy(held.botId, other));
      if (oldest) release(oldest[0], true);
    }
    return reserved.size < PRESTART_MOST;
  };

  /** Starts `threadId`'s engine from the bot's last launch; `opened`: the conversation has messages already. */
  const start = (botId: string, threadId: string, opened: boolean): void => {
    const from = launches.get(botId);
    const adapter = from && deps.adapter(from.instanceId)?.prestart;
    if (!from || !adapter || reserved.has(threadId) || adapter.running(threadId) || !deps.allowed() || deps.busy(botId, threadId)
      || deps.shape(botId, threadId) !== from.shape || deps.refused(botId, threadId)) return;
    let input = from.input.replaceAll(from.threadId, threadId);
    const cwd = (JSON.parse(input) as SendTurnInput).cwd;
    if (!cwd || deps.folder(botId, threadId) !== cwd) {
      if (opened) unused.set(threadId, now());
      return;
    }
    if (!room(opened)) return;
    for (const bearer of from.bearers) input = input.replaceAll(bearer.token, bearerFor(botId, threadId, bearer.slot, bearer.grants));
    const cursor = opened ? deps.cursor(botId, threadId, from.instanceId) : undefined;
    const launch = { ...(JSON.parse(input) as SendTurnInput), text: "", ...(cursor ? { resumeCursor: cursor } : {}) };
    const waitMs = opened ? OPENED_PRESTART_IDLE_MS : deps.idleMs ?? PRESTART_IDLE_MS;
    const timer = setTimeout(() => {
      if (opened && !deps.busy(botId, threadId)) unused.set(threadId, now());
      release(threadId, !deps.busy(botId, threadId));
    }, waitMs + RELEASE_AFTER_MS);
    timer.unref?.();
    const reservation = { botId, instanceId: from.instanceId, timer, opened, at: now(), waitMs };
    reserved.set(threadId, reservation);
    const releaseOwn = (retire: boolean) => { if (reserved.get(threadId) === reservation) release(threadId, retire); };
    void adapter.start(launch, waitMs).then((up) => { if (!up && !deps.busy(botId, threadId)) releaseOwn(true); },
      () => releaseOwn(!deps.busy(botId, threadId)));
  };

  return {
    /** Called with every turn's input as it goes to its engine; returns it unchanged. A person's own turn becomes what
     * the bot's next new conversation is started from. */
    note(instanceId: string, input: SendTurnInput, person: boolean): SendTurnInput {
      release(input.threadId, false);
      unused.delete(input.threadId);
      const botId = input.botId;
      if (!botId) return input;
      const shape = person && startsOnlyOwnServers(input) ? deps.shape(botId, input.threadId) : null;
      if (shape === null) {
        if (person) launches.delete(botId);
        return input;
      }
      const { text: _text, images: _images, transcript: _transcript, recalled: _recalled, recoveryText: _recovery, resumeCursor: _cursor, sessionReset: _reset,
        startupRecovery: _startup, mentionTurn: _mention, ...launch } = input;
      launches.delete(botId);
      if (launches.size >= LAUNCHES_KEPT) launches.delete(launches.keys().next().value!);
      launches.set(botId, {
        instanceId, threadId: input.threadId, shape, input: JSON.stringify(launch),
        bearers: [...(deps.credentials.get(input.threadId) ?? [])].map(([slot, held]) => ({ slot, ...held })),
      });
      return input;
    },

    /** A person made a conversation: its engine starts now when the bot's last launch says how. */
    threadMade(botId: string, threadId: string): void {
      if (launches.get(botId)?.threadId === threadId || !deps.blank(threadId)) return;
      start(botId, threadId, false);
    },

    /** A person opened a conversation or is typing in it: once it stays in front of them for a moment, its engine starts
     * the way its next turn would start it. Never inline: the open itself must not wait. */
    threadSeen(threadId: string): void {
      if (settling?.threadId === threadId) return;
      if (settling) clearTimeout(settling.timer);
      settling = null;
      const botId = deps.desktop() ? deps.botOf(threadId) : null;
      if (!botId || reserved.has(threadId) || now() - (unused.get(threadId) ?? -Infinity) < OPENED_AGAIN_AFTER_MS) return;
      const timer = setTimeout(() => {
        if (settling?.timer === timer) settling = null;
        try { start(botId, threadId, !deps.blank(threadId)); } catch (error) { console.warn(`engine prestart: ${(error as Error).message}`); }
      }, OPENED_SETTLE_MS);
      timer.unref?.();
      settling = { threadId, timer };
    },

    /** A person is typing in the conversation: an engine that went unused there before may start again. */
    typedIn(threadId: string): void {
      unused.delete(threadId);
    },

    /** The conversation's bearers were retired (a Stop, a delete): an engine started ahead with them goes too. */
    drop(threadId: string): void {
      if (settling?.threadId === threadId) { clearTimeout(settling.timer); settling = null; }
      release(threadId, true);
      unused.delete(threadId);
    },

    waiting: (): string[] => [...reserved.keys()],
  };
}
export type EnginePrestart = ReturnType<typeof createEnginePrestart>;
