// A bot's own threads: list_models, start_thread and the thread's turn start share one check, so a model the list offers
// always opens, and a second opinion never quietly comes from the opener's own model.
import type { ModelSelection } from "../../shared/wire.ts";
import { modelMenu, type MenuEngine, type ModelMenu } from "../routes/internal-models.ts";
import type { BotRecord, Store } from "../store.ts";
import type { NewThreadLevel } from "../task-record.ts";
import type { ThreadModelFallback } from "../thread-model.ts";
import type { EngineHint } from "./engine-hints.ts";
import { createSpawnLevel, type SpawnLevelDeps } from "./spawn-level.ts";

type Placed = { botId: string; threadId: string; groupId?: string };
type Node = Omit<Placed, "threadId"> & { parentId?: string };

export function createOwnThreads(deps: Pick<SpawnLevelDeps, "sourceLevel" | "mayRaise"> & {
  store: Pick<Store, "bot" | "taskByThread" | "projectBotForTask">;
  registry: { instances(): readonly MenuEngine[]; cliTarget(instanceId: string): { driverKind: string } | null | undefined };
  node(id: string): Node | undefined;
  current(botId: string, threadId: string): ModelSelection | undefined;
  /** propose_model's check: offered, not turned off by the organization, the bot's permissions carry over. */
  proposalRefusal(selection: ModelSelection, bot: BotRecord): string | null;
  /** Why turn start would run a thread chosen on `selection` on the bot's own model instead. */
  givesWay(selection: ModelSelection, botModel: ModelSelection): ThreadModelFallback | null;
  modelName(selection: ModelSelection): string;
  /** Why an engine can't run now and how the person connects it (engine-hints.ts). */
  hint(instanceId: string): EngineHint;
  /** Engines whose saved settings could not be read. */
  broken?(): ReadonlyArray<{ name: string; hint: EngineHint }>;
  /** The engines with a local model the Other engine offers listed there only, and the line that says where else it runs. */
  localOnce?(engines: readonly MenuEngine[]): { engines: MenuEngine[]; also?: string };
}) {
  const { store } = deps;
  /** The level a new thread opened from a conversation starts at (spawn-level.ts). */
  const levelFor = createSpawnLevel({ ...deps, driverKind: (instanceId) => deps.registry.cliTarget(instanceId)?.driverKind });
  const own = (requester: Omit<Placed, "threadId">, child: Omit<Placed, "threadId">) =>
    requester.botId === child.botId && !requester.groupId && !child.groupId;
  const cannotRun = (selection: ModelSelection, bot: BotRecord): string | null => {
    const givesWay = deps.givesWay(selection, bot.modelSelection);
    return givesWay && `${deps.modelName(selection)} can't run now: ${givesWay === "signed-out" ? "it is signed out" : "its engine is unavailable"}.`;
  };
  const refusal = (selection: ModelSelection, bot: BotRecord): string | null => deps.proposalRefusal(selection, bot) ?? cannotRun(selection, bot);
  return {
    own,
    refusal,
    /** A report-back thread whose model can no longer run fails with this reason instead of running on the bot's own model. */
    swapRefusal(bot: BotRecord, threadId: string): string | null {
      const chosen = store.taskByThread(bot.id, threadId)?.modelSelection;
      const reason = chosen && cannotRun(chosen, bot);
      return reason ? `${reason} Nothing ran on another model in its place; open it again on a model list_models offers.` : null;
    },
    /** `thread` is a report-back thread `botId` opened from `fromThreadId`: its opener may steer it or send it follow-ups. */
    steersOwn(thread: string, botId: string, fromThreadId: string): boolean {
      const openedBy = thread === "new" || thread === "standing" ? undefined : store.taskByThread(botId, thread)?.openedBy;
      return openedBy?.botId === botId && openedBy.threadId === fromThreadId && openedBy.kind === undefined && !openedBy.roomLane;
    },
    /** `answers` names a question one of `botId`'s own threads waits on: with steersOwn, the only messages a bot may address to itself. */
    answersOwn(answers: string | undefined, botId: string): boolean {
      const asked = answers === undefined ? undefined : deps.node(answers);
      const requester = asked?.parentId === undefined ? undefined : deps.node(asked.parentId);
      return Boolean(asked && requester && requester.botId === botId && own(requester, asked));
    },
    levelFor,
    /** A burst child's level: the conversation it was opened from, on `selection`; "ask" where that level does not carry over. */
    approvalFor(bot: BotRecord, selection: ModelSelection, fromThreadId?: string): NewThreadLevel | undefined {
      return levelFor(bot, selection, fromThreadId === undefined ? undefined : { botId: bot.id, threadId: fromThreadId });
    },
    /** A thread the bot opens on itself from `parentThreadId`: on `picked`, else that conversation's model, at its level. */
    inherited(botId: string, parentThreadId: string, picked?: ModelSelection): { modelSelection?: ModelSelection; approvalMode?: NewThreadLevel } {
      const bot = store.bot(botId);
      if (!bot) return {};
      const modelSelection = picked ?? store.taskByThread(bot.id, parentThreadId)?.modelSelection;
      const approvalMode = levelFor(bot, modelSelection, { botId, threadId: parentThreadId });
      return { ...(modelSelection ? { modelSelection } : {}), ...(approvalMode ? { approvalMode } : {}) };
    },
    name(requester: Omit<Placed, "threadId">, child: Placed): string | undefined {
      return own(requester, child) ? `#${store.taskByThread(child.botId, child.threadId)?.title ?? "Thread"}` : undefined;
    },
    label(child: Placed): string {
      const task = store.taskByThread(child.botId, child.threadId);
      return ` (your thread #${task?.title ?? "Thread"}${task?.modelSelection ? `, on ${task.modelSelection.model}` : ""})`;
    },
    menu(botId: string, threadId: string, search: string | undefined): ModelMenu | null {
      const bot = store.bot(botId);
      if (!bot) return null;
      const current = deps.current(botId, threadId) ?? bot.modelSelection;
      const listed: { engines: readonly MenuEngine[]; also?: string } = deps.localOnce?.(deps.registry.instances()) ?? { engines: deps.registry.instances() };
      const menu = modelMenu({ engines: listed.engines, current, pinned: [bot.modelSelection], refusal: (selection) => refusal(selection, bot),
        down: (engine) => deps.givesWay({ instanceId: engine.instanceId, model: engine.models.default }, bot.modelSelection) === "unavailable" ? deps.hint(engine.instanceId) : null,
        signedOut: (engine) => deps.givesWay({ instanceId: engine.instanceId, model: engine.models.default }, bot.modelSelection) === "signed-out" ? deps.hint(engine.instanceId) : null,
        broken: deps.broken?.() ?? [], search });
      return listed.also ? { ...menu, localAlso: listed.also } : menu;
    },
  };
}
