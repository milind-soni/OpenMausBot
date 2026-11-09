// A bot's own threads: list_models, start_thread and the thread's turn start share one check, so a model the list offers
// always opens, and a second opinion never quietly comes from the opener's own model.
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { modelMenu, type MenuEngine, type ModelMenu } from "../routes/internal-models.ts";
import type { BotRecord, Store } from "../store.ts";
import type { ThreadModelFallback } from "../thread-model.ts";

type Placed = { botId: string; threadId: string; groupId?: string };
type Node = Omit<Placed, "threadId"> & { parentId?: string };

export function createOwnThreads(deps: {
  store: Pick<Store, "bot" | "taskByThread">;
  registry: { instances(): readonly MenuEngine[]; cliTarget(instanceId: string): { driverKind: string } | null | undefined };
  node(id: string): Node | undefined;
  current(botId: string, threadId: string): ModelSelection | undefined;
  /** propose_model's check: offered, not turned off by the organization, the bot's permissions carry over. */
  proposalRefusal(selection: ModelSelection, bot: BotRecord): string | null;
  /** Why turn start would run a thread chosen on `selection` on the bot's own model instead. */
  givesWay(selection: ModelSelection, botModel: ModelSelection): ThreadModelFallback | null;
  modelName(selection: ModelSelection): string;
}) {
  const { store } = deps;
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
    /** `answers` names a question one of `botId`'s own threads waits on: the one message a bot may address to itself. */
    answersOwn(answers: string | undefined, botId: string): boolean {
      const asked = answers === undefined ? undefined : deps.node(answers);
      const requester = asked?.parentId === undefined ? undefined : deps.node(asked.parentId);
      return Boolean(asked && requester && requester.botId === botId && own(requester, asked));
    },
    /** "ask" when running on `selection` crosses to an engine where this bot's permission level does not carry over. */
    approvalFor(bot: BotRecord, selection: ModelSelection): "ask" | undefined {
      return modelSwitchNeedsAsk(approvalModeFor(bot), deps.registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, deps.registry.cliTarget(selection.instanceId)?.driverKind) ? "ask" : undefined;
    },
    inherited(botId: string, parentThreadId: string): { modelSelection?: ModelSelection; approvalMode?: "ask" } {
      const bot = store.bot(botId);
      const modelSelection = bot && store.taskByThread(bot.id, parentThreadId)?.modelSelection;
      if (!bot || !modelSelection) return {};
      const needsAsk = modelSwitchNeedsAsk(approvalModeFor(bot),
        deps.registry.cliTarget(bot.modelSelection.instanceId)?.driverKind,
        deps.registry.cliTarget(modelSelection.instanceId)?.driverKind);
      return { modelSelection, ...(needsAsk ? { approvalMode: "ask" as const } : {}) };
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
      return modelMenu({ engines: deps.registry.instances(), current, pinned: [bot.modelSelection], refusal: (selection) => refusal(selection, bot),
        down: (engine) => deps.givesWay({ instanceId: engine.instanceId, model: engine.models.default }, bot.modelSelection) === "unavailable", search });
    },
  };
}
