// Wires a new Cloud's first hour into the server (server/host/README.md): the counts every personal Cloud keeps, the
// hooks the brief and the read-and-draft fence call before the first hour exists, and the first hour itself once its
// Chief and services are up.
import { CLOUD_WELCOME_DONE } from "../../shared/cloud-hints.ts";
import type { Notification } from "../../shared/notification.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { AppConfig } from "../config.ts";
import type { RoutineManager } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";
import { createFirstHour, LOOK_APPS, type FirstHour, type FirstHourDeps, type LookApp } from "./first-hour.ts";
import type { Proactive } from "./proactive.ts";
import { proactiveOwner } from "./proactive-owner.ts";
import { createValueLedger, valueReport, type ValueKind } from "./value-ledger.ts";

/** Made before the proactive Chief, on a personal Cloud: the first hour attaches to it later. */
export function createFirstHourHooks(options: { dataDir: string; personal: boolean }) {
  const ledger = options.personal ? createValueLedger({ dataDir: options.dataDir }) : null;
  let current: FirstHour | null = null;
  return {
    ledger,
    /** For createProactive: the counts, the first look's fence and the morning brief. */
    proactive: {
      counted: (kind: ValueKind, count: number) => ledger?.add(kind, count),
      look: (threadId: string) => current?.look(threadId) ?? null,
      morning: {
        at: () => current?.morningAt(),
        push: (summary: string) => current?.morningPush(summary) ?? summary,
        overnight: (since: number) => (ledger ? current?.overnight(ledger.since(since)) : undefined),
      },
    },
    attach(firstHour: FirstHour): void { current = firstHour; },
    /** The first day's words for the Chief's own chat, or nothing. */
    prompt: (botId: string, threadId: string): string => current?.prompt(botId, threadId) ?? "",
    arrived: (): void => current?.arrived(),
    health: () => ({
      ...(current?.health() ? { firstHour: current.health() } : {}),
      ...(ledger ? { value: valueReport(current?.tally() ?? { ...ledger.totals(), routines: 0 }) } : {}),
    }),
  };
}

export type FirstHourHooks = ReturnType<typeof createFirstHourHooks>;

export interface FirstHourHostDeps {
  hooks: FirstHourHooks;
  /** This boot made the place: a new personal Cloud, whose first hour begins now. */
  fresh: boolean;
  store: Store;
  bus: { subscribe(listener: (event: RuntimeEvent) => void): unknown };
  cfg: AppConfig;
  dataDir: string;
  proactive: Pick<Proactive, "brief">;
  /** The brief is on: the proactive bot's briefing routine. */
  briefOn(): boolean;
  ensureBrief(): void;
  composio: {
    configured(cfg: AppConfig): boolean;
    connectedServices(cfg: AppConfig): Promise<Record<string, { connected: boolean }>>;
    toolkitCard(cfg: AppConfig, slug: string): Promise<{ label: string; blurb?: string }>;
  };
  sessions: { list(): ReadonlyArray<{ owner?: string; email?: string; scopes: readonly string[] }> };
  phones(): number;
  routines(): RoutineManager | null;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  startTurn: FirstHourDeps["startTurn"];
  notify(notification: Notification | null): void;
  wrote(bot: BotRecord, threadId: string): void;
  welcomeDone(): void;
  /** An event from a turn that no longer counts (a replaced or stopped one). */
  stale(event: RuntimeEvent): boolean;
}

/** Null where there is no first hour: anything but a personal Cloud, or one made before it existed. */
export function startFirstHour(deps: FirstHourHostDeps): FirstHour | null {
  if (!deps.hooks.ledger) return null;
  const { store, cfg, composio } = deps;
  const firstHour = createFirstHour({
    store, dataDir: deps.dataDir,
    chief: () => proactiveOwner(store),
    mainThread: deps.mainThread, threadBusy: deps.threadBusy,
    person: () => {
      const name = cfg.profile?.name?.trim();
      const email = deps.sessions.list().find((session) => session.scopes.includes("admin") && session.owner)?.owner;
      return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
    },
    language: () => deps.proactive.brief.language(),
    timeZone: () => deps.proactive.brief.timeZone(),
    apps: {
      reachable: (bot) => composio.configured(cfg) && bot.composio !== false,
      connected: async () => {
        if (!composio.configured(cfg)) return null;
        const services = await composio.connectedServices(cfg);
        return Object.fromEntries(LOOK_APPS.map((app) => [app, services[app]?.connected === true])) as Record<LookApp, boolean>;
      },
      card: async (slug) => {
        const card = await composio.toolkitCard(cfg, slug);
        return { label: card.label, description: card.blurb ?? "" };
      },
    },
    briefOn: deps.briefOn,
    ensureBrief: deps.ensureBrief,
    phones: deps.phones,
    startTurn: deps.startTurn,
    notify: (bot, threadId, body) => deps.notify(bot.notifications === false ? null : { kind: "brief", botId: bot.id, botName: bot.name, threadId, title: bot.name, body, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) }),
    wrote: deps.wrote,
    welcomeDone: deps.welcomeDone,
    runs: () => deps.routines()?.listRuns() ?? [],
    ledger: deps.hooks.ledger,
  });
  if (deps.fresh) firstHour.begin();
  if (!firstHour.active()) return null;
  deps.hooks.attach(firstHour);
  store.onChange((change) => {
    if (change.type === "message") firstHour.message(change.threadId, change.message);
    else if (change.type === "message.patch") firstHour.patched(change.threadId, change.message);
  });
  deps.bus.subscribe((event) => {
    if (event.type === "turn.completed" && !deps.stale(event)) firstHour.turnCompleted(event.threadId, event.ok);
  });
  firstHour.start();
  return firstHour;
}

/** The config patch that ends a new Cloud's welcome steps: it opens on its Chief's chat. */
export function welcomeDonePatch(onboarding: AppConfig["onboarding"]): { onboarding: { hintsSeen: string[] } } {
  return { onboarding: { hintsSeen: [...new Set([...(onboarding?.hintsSeen ?? []), CLOUD_WELCOME_DONE])] } };
}
