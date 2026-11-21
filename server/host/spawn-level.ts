// A thread a bot opens from a conversation (its own start_thread and report_back, a burst child, a teammate's new or work
// thread from a hand-off) starts at the level the person chose in that conversation, both ways: a chat at Full access opens
// Full access threads and a chat at Ask opens Ask ones, whatever the bot's own saved level (docs/approval-levels.md).
import { approvalModeFor, levelWithin, modelSwitchNeedsAsk, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { BotRecord, Store } from "../store.ts";
import type { NewThreadLevel } from "../task-record.ts";

export interface SpawnLevelDeps {
  store: Pick<Store, "taskByThread" | "projectBotForTask">;
  driverKind(instanceId: string): string | undefined;
  /** The level a turn in that conversation runs at, its floors applied: a guest's, a Bot API key's or a fenced turn runs at Ask. */
  sourceLevel(botId: string, threadId: string): ApprovalMode;
  /** Whoever drives that conversation may set a level there: not work from outside, nor a guest or anyone but the owner on a
   * Cloud, nor a hosted workspace without its operator's policy. Lowering needs no one. */
  mayRaise(threadId: string): boolean;
}

/** The conversation a thread is opened from. A room's thread is never one: a room keeps no level of its own. */
export type Opener = { botId: string; threadId: string };

export function createSpawnLevel(deps: SpawnLevelDeps) {
  const { store } = deps;
  const needsAsk = (mode: ApprovalMode, from: ModelSelection, to: ModelSelection) =>
    modelSwitchNeedsAsk(mode, deps.driverKind(from.instanceId), deps.driverKind(to.instanceId));

  /** What a new thread of `target` on `selection` saves: `from`'s level when that conversation has a settled one of its own and
   * it differs from `target`'s, capped by the engine the thread runs on; undefined starts it at `target`'s own (task-record.ts). */
  return function levelFor(target: BotRecord, selection: ModelSelection = target.modelSelection, from?: Opener): NewThreadLevel | undefined {
    const own = approvalModeFor({ ...target, approvalGrant: undefined });
    const ownCarries = needsAsk(own, target.modelSelection, selection) ? "ask" as const : undefined;
    const task = from && store.taskByThread(from.botId, from.threadId);
    const view = from && store.projectBotForTask(from.botId, from.threadId);
    // No level of its own, or none a person chose (a routine run's conversation copies its bot's), or one the desktop is still
    // confirming (never its Ask mask, never an unconfirmed Full), or the target's own bot-wide change pending, under which a
    // new thread follows its bot: as before.
    if (!from || !task || !view || view.approvalGrant || task.routineRunId || (task.approvalMode === undefined && task.autoApprove === undefined) ||
      (target.approvalGrant && !target.approvalGrant.threadOnly)) return ownCarries;
    const chosen = approvalModeFor(view);
    const runs = deps.sourceLevel(from.botId, from.threadId);
    // A floor held that conversation at Ask (a guest, a Bot API key, the fence, its engine): so does what it opens.
    if (runs !== chosen) return "ask";
    // Custom is one Codex configuration the desktop alone may grant: never copied, and nothing above it comes in its place.
    const level: ApprovalMode = chosen === "custom" && (own !== "custom" || from.botId !== target.id) ? "ask" : chosen;
    // A thread of a bot on Custom keeps the configuration the person wrote, as a Chief's level leaves it (delegated-level.ts).
    if (level === own || own === "custom") return ownCarries;
    if (!levelWithin(level, own) && !deps.mayRaise(from.threadId)) return ownCarries;
    return needsAsk(level, view.modelSelection, selection) ? "ask" : { from: level };
  };
}
