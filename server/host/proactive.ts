// The proactive main agent, wired from ordinary routines: the checks a routine runs before any AI turn, the
// read-and-draft fence its runs work inside, the brief its results become, and the proactive bot's default "Keep an eye
// on my day" routine, created once with no button on a personal install or a personal Cloud that can reach connected
// apps, and never on a team's. The brief is there only while that routine is on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { NeedsYouItem } from "../../shared/today.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import type { Notification } from "../../shared/notification.ts";
import type { RequestAuth } from "../request-auth.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { AppConfig } from "../config.ts";
import { createConnectedReads, READ_APPS, type ReadApp } from "../connected-reads.ts";
import { evaluateConnectorTools } from "../connector-verdict.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { ProviderAdapter } from "../contracts.ts";
import { createReadAndDraft, type ReadAndDraftDeps } from "../read-and-draft.ts";
import type { Routine, RoutineChecks, RoutineManager, RoutineRun } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";
import { deciderEnabled, type Decider } from "../decider/index.ts";
import type { Extractor } from "../extractor/index.ts";
import { createBrief, type BriefDeps, type MorningDeps } from "./brief.ts";
import { WATCH_EVERY_MINUTES, WATCH_INSTRUCTIONS, WATCH_NAME } from "./default-watch.ts";
import { createHelperSuggestion } from "./helper-suggestion.ts";
import { createInboxTriage } from "./inbox-triage.ts";
import { mainChief, proactiveOwner } from "./proactive-owner.ts";
import { createRoutineChecks } from "./routine-checks.ts";
import type { ValueKind } from "./value-ledger.ts";

export { WATCH_INSTRUCTIONS, WATCH_NAME } from "./default-watch.ts";
export const WATCH_FILE = "watch.json";
/** The engines whose every tool use outside a run's allowlist reaches OpenMausBot's answerer and is refused there. */
const FENCED_ENGINES = new Set(["claudeAgent"]);
const READ_SLUG: Record<ReadApp, string> = { gmail: "GMAIL_FETCH_EMAILS", googlecalendar: "GOOGLECALENDAR_EVENTS_LIST" };
const ACTIVE = new Set(["queued", "running", "waiting"]);
const MAX_HANDED = 50;
const watchSchema = z.object({
  version: z.literal(1),
  routineId: z.string().max(512).optional(),
  /** The default routine was made here: it is never made again. */
  createdAt: z.number().finite().nonnegative().optional(),
  /** Each briefing routine, by id, and the proactive bot it was placed on: it is handed to a bot once, so one the person
   * moves off it later is left where they put it. */
  handed: z.record(z.string().max(512), z.string().max(512)).optional(),
});
type WatchRecord = Omit<z.infer<typeof watchSchema>, "version">;
const isWatch = (routine: Routine): boolean => routine.target === "bot" && routine.deliver === "brief" && Boolean(routine.checks?.length);

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;

export interface ProactiveDeps {
  store: Store;
  cfg: AppConfig;
  composio: {
    configured(cfg: AppConfig): boolean;
    connectedServices(cfg: AppConfig): Promise<Record<string, { connected: boolean }>>;
    relayMcp(cfg: AppConfig, payload: never, transportSessionId?: string, beforeSend?: () => void, signal?: AbortSignal): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
  };
  registry: { get(instanceId: string): { driverKind: string; adapter: ProviderAdapter } | null | undefined };
  dataDir: string;
  /** A hosted team workspace or a Team Cloud. */
  team: boolean;
  /** This computer's bots moved to My Cloud: nothing here is changed. */
  frozen?: () => boolean;
  /** Any Cloud (a Cloud home included): the add-a-key suggestion is never shown there. */
  cloud?: boolean;
  routines(): RoutineManager | null;
  mainThread: BriefDeps["mainThread"];
  threadBusy: BriefDeps["threadBusy"];
  notify(notification: Notification | null): void;
  engineName(instanceId: string): string;
  needsYou(): NeedsYouItem[];
  hostTimeZone(): string | undefined;
  decide(row: Omit<DecisionRow, "at">): void;
  stale(event: RequestOpened): boolean;
  release(threadId: string): void;
  /** A routine the server made for the owner is the owner's, as one they made here. */
  owned(routine: Routine): void;
  /** The decision and extraction models: with them on, they sort the inbox on any engine. */
  helpers?: { decider: Pick<Decider, "choose">; extractor: Pick<Extractor, "extract"> };
  /** The owner's last nightly dream, for the brief's Ideas. */
  ideas?: BriefDeps["ideas"];
  /** What the proactive bot did, counted as it happens: emails sorted, replies drafted, meetings prepared. */
  counted?(kind: ValueKind, count: number): void;
  /** A new Cloud's first look, confined like a read-and-draft run. */
  look?: ReadAndDraftDeps["look"];
  morning?: MorningDeps;
}

export function createProactive(deps: ProactiveDeps) {
  const { store, cfg, composio } = deps;
  const reads = createConnectedReads({
    connected: async () => {
      if (!composio.configured(cfg)) return null;
      const services = await composio.connectedServices(cfg);
      return Object.fromEntries(READ_APPS.map((app) => [app, services[app]?.connected === true])) as Record<ReadApp, boolean>;
    },
    relay: (payload, session, signal) => composio.relayMcp(cfg, payload as never, session, undefined, signal),
  });

  /** Connected apps are on for this bot, and its own app switches and tool grants let it read this app. */
  function mayRead(botId: string, app: ReadApp): boolean {
    const bot = store.bot(botId);
    if (!bot || bot.composio === false || !composio.configured(cfg)) return false;
    const slug = READ_SLUG[app];
    return connectorAccessDecision(bot.connectorScopes, [{ slug }], [...READ_APPS]).ok && evaluateConnectorTools([slug], bot.connectorTools, [...READ_APPS]).allowed;
  }
  const fenced = (botId: string): boolean => {
    const bot = store.bot(botId);
    return Boolean(bot && FENCED_ENGINES.has(deps.registry.get(bot.modelSelection.instanceId)?.driverKind ?? ""));
  };
  const runs = (): RoutineRun[] => [...(deps.routines()?.listRuns() ?? [])].reverse();
  const owner = () => proactiveOwner(store);
  /** The owner's briefing routine is on: pausing or deleting it switches the brief off. */
  const watching = (): boolean => {
    const bot = owner();
    return Boolean(bot && deps.routines()?.listRoutines().some((routine) => routine.botId === bot.id && routine.deliver === "brief" && routine.enabled));
  };

  const brief = createBrief({
    store, dataDir: deps.dataDir, hosted: deps.team, watching, mainThread: deps.mainThread, threadBusy: deps.threadBusy, runs,
    needsYou: deps.needsYou, engineName: deps.engineName, hostTimeZone: deps.hostTimeZone, language: () => cfg.language,
    notify: (bot, threadId, detail) => deps.notify(briefNotification(bot, threadId, detail)),
    session: () => (composio.configured(cfg) ? reads.session() : null),
    address: () => checks.address(),
    failRun: (runId, why) => deps.routines()?.rejectResult(runId, why),
    keep: (key) => checks.commit(key),
    items: (key) => checks.items(key),
    ...(deps.ideas ? { ideas: deps.ideas } : {}),
    prepped: () => deps.counted?.("prepped", 1),
    ...(deps.morning ? { morning: deps.morning } : {}),
  });
  const inbox = deps.helpers ? createInboxTriage({ ...deps.helpers, config: () => cfg }) : undefined;
  const suggestion = createHelperSuggestion({
    store, dataDir: deps.dataDir, cloud: deps.cloud !== false || deps.team, owner, mainThread: deps.mainThread, threadBusy: deps.threadBusy,
    // Set up and on, or switched off on purpose: either way there is nothing to suggest.
    settled: () => deciderEnabled(cfg) || cfg.decider?.enabled === false || cfg.decider?.provider === "off",
  });
  const checks = createRoutineChecks({
    dataDir: deps.dataDir, reads, mayRead, fenced, runs, timeZone: brief.timeZone, dismissedFrom: brief.dismissedFrom,
    report: async (found) => {
      await brief.report(found);
      if (found.gmail) suggestion.consider({ gmailConnected: found.gmail.connected, ...(found.gmail.address ? { inbox: found.gmail.address } : {}) });
    },
    ...(inbox ? { inbox } : {}),
    sorted: (routineId, count) => {
      if (deps.routines()?.listRoutines().find((routine) => routine.id === routineId)?.botId === owner()?.id) deps.counted?.("sorted", count);
    },
  });
  /** One brief, the main agent's: a briefing routine of any other bot finds nothing to do. */
  const routineChecks: RoutineChecks = {
    check: (routine, context) => (deps.team || (routine.deliver === "brief" && routine.botId !== owner()?.id) ? Promise.resolve({}) : checks.check(routine, context)),
    release: checks.release,
    settled: (run) => {
      checks.settled(run);
      if (run.deliver === "brief" && run.status === "failed") void brief.refresh();
    },
  };
  const fence = createReadAndDraft({
    runFor: (threadId) => deps.routines()?.runForThread(threadId) ?? null,
    adapter: (instanceId) => deps.registry.get(instanceId)?.adapter,
    stale: deps.stale, decide: deps.decide, release: deps.release,
    mayDraft: checks.mayDraft, drafted: checks.drafted,
    ...(deps.look ? { look: deps.look } : {}),
    wroteDrafts: (botId, count) => { if (botId === owner()?.id) deps.counted?.("drafted", count); },
  });

  const watchFile = join(deps.dataDir, WATCH_FILE);
  let record: WatchRecord | undefined;
  const watchRecord = (): WatchRecord => {
    if (!record) {
      try {
        const parsed = watchSchema.safeParse(JSON.parse(readFileSync(watchFile, "utf8")));
        record = parsed.success ? { ...parsed.data } : {};
      } catch {
        record = {};
      }
    }
    return record;
  };
  const remember = (next: WatchRecord): void => {
    record = next;
    try {
      writeFileAtomic(watchFile, `${JSON.stringify({ version: 1, ...next })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`watch: could not save ${watchFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The watch the main Chief holds becomes the proactive bot's, once: the same routine, so its switch, the instructions
   * the person edited, its checks' cursors and seen ids and its daily cap stay as they are. Never while one of its runs
   * is queued or working. A briefing routine newly on the bot, handed over or arrived with it, is the one: every other is
   * paused, never deleted, and the brief moves to the bot's chat. A restart between the steps finishes them. */
  function handOver(manager: RoutineManager, bot: BotRecord): void {
    const kept = watchRecord();
    const handed = { ...kept.handed };
    const watches = manager.listRoutines().filter(isWatch);
    const chief = mainChief(store);
    const before = chief && chief.id !== bot.id ? watches.filter((routine) => routine.botId === chief.id && handed[routine.id] !== bot.id) : [];
    const runs = before.length ? manager.listRuns() : [];
    if (before.some((routine) => runs.some((run) => run.routineId === routine.id && ACTIVE.has(run.status)))) return;
    const placed = watches.filter((routine) => routine.botId === bot.id && handed[routine.id] !== bot.id).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const routine of before) {
      const moved = manager.update(routine.id, { botId: bot.id });
      if (moved) placed.push(moved);
    }
    const watch = placed.at(-1);
    if (!watch) return;
    for (const other of manager.listRoutines()) if (isWatch(other) && other.id !== watch.id && other.enabled) manager.update(other.id, { enabled: false });
    brief.moveTo(bot.id);
    for (const routine of placed) handed[routine.id] = bot.id;
    remember({ ...kept, handed: Object.fromEntries(Object.entries(handed).slice(-MAX_HANDED)) });
  }

  /** The proactive bot's default routine, once, when connected apps are there to read: pausing or deleting it is how it
   * is switched off, so it is never made again. Asked at start and every minute, since a Cloud's access arrives later,
   * and a MausBot can arrive after the routine was made. */
  function ensureWatch(): Routine | null {
    const manager = deps.routines();
    const bot = owner();
    if (deps.team || deps.frozen?.() || !manager || !bot) return null;
    try {
      handOver(manager, bot);
    } catch (error) {
      console.warn(`watch: not handed over yet: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!composio.configured(cfg) || watchRecord().createdAt) return null;
    const existing = manager.listRoutines().find((routine) => routine.botId === bot.id && isWatch(routine));
    const routine = existing ?? manager.create({
      name: WATCH_NAME, prompt: WATCH_INSTRUCTIONS, botId: bot.id, enabled: true, timeoutMinutes: 15,
      schedule: { type: "interval", everyMinutes: WATCH_EVERY_MINUTES, anchorAt: Date.now() + WATCH_EVERY_MINUTES * 60_000 },
      checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief",
    });
    if (!existing) deps.owned(routine);
    remember({ ...watchRecord(), routineId: routine.id, createdAt: Date.now(), handed: { ...watchRecord().handed, [routine.id]: bot.id } });
    return routine;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    checks: routineChecks, fence, brief,
    /** The brief is on: the proactive bot's briefing routine is. */
    briefOn: watching,
    /** Only the owner dreams, and only while its brief is on: at most one model call a night, with no switch of its own. */
    dreamer: (): string | undefined => (watching() ? owner()?.id : undefined),
    /** Not now on the add-a-key suggestion; the inbox connected now is remembered with it. */
    suggestionNotNow: (threadId: string, messageId: string, auth: RequestAuth) => {
      const address = checks.address();
      return suggestion.notNow(threadId, messageId, auth, address ? [address] : []);
    },
    ensureWatch,
    /** A routine run's turn ended: a briefing run's answer becomes the brief's rows. */
    runSettled: (run: RoutineRun, turnId: string | undefined): void => void brief.consume(run, turnId).catch((error: unknown) => console.warn("brief: a run's answer was not kept", error)),
    start(): void {
      if (timer || deps.team) return;
      timer = setInterval(() => {
        brief.tick();
        try { ensureWatch(); } catch (error) { console.warn("watch: not made yet", error); }
      }, 60_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function briefNotification(bot: BotRecord, threadId: string, detail: string): Notification | null {
  if (bot.notifications === false) return null;
  return { kind: "brief", botId: bot.id, botName: bot.name, threadId, title: bot.name, body: detail.slice(0, 200), ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) };
}

export type Proactive = ReturnType<typeof createProactive>;
