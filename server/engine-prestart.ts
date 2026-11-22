// Starting a new conversation's engine before its first message. An engine process is launched for one conversation
// (its folder, its session and its bearers are in the launch), so nothing can be kept spare for whichever comes next.
// What can be known ahead is the launch the bot's last conversation used: a new conversation on the same bot, with the
// same model, approval level and folder rule, launches the same way but for its own id and its own bearers. This file
// keeps that last launch per bot, rewrites it for the new conversation and asks the driver to start it. The driver takes
// the process for the first turn only when that turn's own launch comes out identical, and replaces it otherwise
// so a wrong guess costs a process that was never used, never a wrong one that was.
//
// Not started ahead: a bot's very first conversation (no launch to go by), a launch that mounts anything beyond
// OpenMausBot's own tool servers (a person's MCP servers, connected apps, a browser or a computer would be started
// early), a guest's or tool-scoped turn, and any host where engines wait for memory.
import { randomBytes } from "node:crypto";

import type { ProviderAdapter, SendTurnInput } from "./contracts.ts";
import { PRESTART_IDLE_MS, PRESTART_MOST } from "./drivers/session-idle.ts";

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
    && !input.guestConfined && !input.mcpFromUserConfig && input.toolScope === undefined;
}

const RELEASE_AFTER_MS = 5_000;
/** One launch per bot, for the bots a person wrote to most recently. */
const LAUNCHES_KEPT = 32;

export function createEnginePrestart(deps: EnginePrestartDeps) {
  const launches = new Map<string, Launch>();
  /** Conversations given bearers ahead of any turn, until a turn uses them or they are retired. */
  const reserved = new Map<string, { botId: string; instanceId: string; timer: ReturnType<typeof setTimeout> }>();

  const release = (threadId: string, retire: boolean) => {
    const held = reserved.get(threadId);
    if (!held) return;
    clearTimeout(held.timer);
    reserved.delete(threadId);
    if (!retire) return;
    deps.adapter(held.instanceId)?.prestart?.drop(threadId);
    deps.credentials.delete(threadId);
  };

  const bearerFor = (botId: string, threadId: string, slot: string, grantedElsewhere: string): string =>
    bearerForGrants(deps.credentials, threadId, slot, JSON.stringify({ ...JSON.parse(grantedElsewhere), threadId, approval: deps.approval(botId, threadId) }));

  return {
    /** Called with every turn's input as it goes to its engine; returns it unchanged. A person's own turn becomes what
     * the bot's next new conversation is started from. */
    note(instanceId: string, input: SendTurnInput, person: boolean): SendTurnInput {
      release(input.threadId, false);
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
      const from = launches.get(botId);
      const adapter = from && deps.adapter(from.instanceId)?.prestart;
      if (!from || !adapter || from.threadId === threadId || !deps.allowed() || !deps.blank(threadId) || deps.busy(botId, threadId)
        || deps.shape(botId, threadId) !== from.shape || deps.refused(botId, threadId)) return;
      for (const [other, held] of reserved) if (!deps.adapter(held.instanceId)?.prestart?.held(other)) release(other, !deps.busy(held.botId, other));
      if (reserved.size >= PRESTART_MOST || reserved.has(threadId)) return;
      let input = from.input.replaceAll(from.threadId, threadId);
      const cwd = (JSON.parse(input) as SendTurnInput).cwd;
      if (!cwd || deps.folder(botId, threadId) !== cwd) return;
      for (const bearer of from.bearers) input = input.replaceAll(bearer.token, bearerFor(botId, threadId, bearer.slot, bearer.grants));
      const launch = { ...(JSON.parse(input) as SendTurnInput), text: "" };
      const timer = setTimeout(() => release(threadId, !deps.busy(botId, threadId)), (deps.idleMs ?? PRESTART_IDLE_MS) + RELEASE_AFTER_MS);
      timer.unref?.();
      const reservation = { botId, instanceId: from.instanceId, timer };
      reserved.set(threadId, reservation);
      const releaseOwn = (retire: boolean) => { if (reserved.get(threadId) === reservation) release(threadId, retire); };
      void adapter.start(launch).then((up) => { if (!up && !deps.busy(botId, threadId)) releaseOwn(true); },
        () => releaseOwn(!deps.busy(botId, threadId)));
    },

    /** The conversation's bearers were retired (a Stop, a delete): an engine started ahead with them goes too. */
    drop(threadId: string): void {
      release(threadId, true);
    },

    waiting: (): string[] => [...reserved.keys()],
  };
}
export type EnginePrestart = ReturnType<typeof createEnginePrestart>;
