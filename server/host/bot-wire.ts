import type { WireBot, WireTask } from "../../shared/wire.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import type { KeepWarmStatus } from "../cache-keepwarm.ts";
import type { ModelSelection } from "../contracts.ts";
import { toWireTask, type BotRecord, type TaskRecord } from "../store.ts";
import type { TeamMessages } from "./team-messages.ts";

export function createBotWire(deps: {
  teammates: () => ReadonlySet<string>; localAgents: () => ReadonlySet<string>;
  keepWarm: (threadId: string) => KeepWarmStatus | undefined; ownTurn: (threadId: string) => unknown;
  inbox: TeamMessages["inbox"]["wire"]; threadBusy: (botId: string, threadId: string) => boolean;
  mainThread: (botId: string) => string | undefined;
}) {
  const wireTask = (task: TaskRecord, botModel: ModelSelection, awaiting = deps.teammates()): WireTask => {
    // Snoozes heal on read against the server clock; the 0 sentinel ("until new activity") survives reads.
    const { snoozedUntil, ...base } = toWireTask(task, botModel);
    const keepWarm = deps.keepWarm(task.threadId);
    const coordinated = { ...base, waitingForTeammates: awaiting.has(task.threadId) && !task.busy, waitingForExternalAgent: deps.localAgents().has(task.threadId) && !task.busy, ...(keepWarm ? { cacheKeepWarm: keepWarm } : {}), ...(deps.ownTurn(task.threadId) ? { private: true as const } : {}), ...deps.inbox(task.threadId) };
    const asleep = snoozedUntil === 0 || (snoozedUntil !== undefined && snoozedUntil > Date.now());
    return asleep ? { ...coordinated, snoozedUntil } : coordinated;
  };

  /** Strips provider session ids (resumeCursors) here, not at call sites, so no broadcast or paired phone ever gets them. */
  const wireBot = (bot: BotRecord): WireBot => {
    const { resumeCursors: _resumeCursors, tasks, approvalGrant, lastProfileRequestId: _lastProfileRequestId, lastTeamSetupReceipt: _lastTeamSetupReceipt, packageBase: _packageBase, assignedSkills: _assignedSkills, mainThreadChoice: _mainThreadChoice, ...rest } = bot;
    // Clients see Ask while an elevated grant awaits the desktop's confirmation, never a grant that may still roll back.
    const visible = approvalGrant && !approvalGrant.threadOnly
      ? { ...rest, approvalMode: "ask" as const, autoApprove: false }
      : { ...rest, approvalMode: approvalModeFor(rest) };
    const awaiting = deps.teammates();
    return { ...visible, waitingForTeammates: awaiting.has(bot.threadId) && !deps.threadBusy(bot.id, bot.threadId), waitingForExternalAgent: deps.localAgents().has(bot.threadId) && !deps.threadBusy(bot.id, bot.threadId),
      mainThreadId: deps.mainThread(bot.id),
      avatarUrl: visible.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map((task) => wireTask(task, bot.modelSelection, awaiting)) } : {}) };
  };

  const wireTrustedApprovalBot = (bot: BotRecord) => {
    const { resumeCursors: _resumeCursors, tasks, approvalGrant: _approvalGrant, lastProfileRequestId: _lastProfileRequestId, lastTeamSetupReceipt: _lastTeamSetupReceipt, packageBase: _packageBase, assignedSkills: _assignedSkills, mainThreadChoice: _mainThreadChoice, ...rest } = bot;
    const awaiting = deps.teammates();
    return { ...rest, approvalMode: approvalModeFor(rest), mainThreadId: deps.mainThread(bot.id), avatarUrl: rest.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map((task) => wireTask(task, bot.modelSelection, awaiting)) } : {}) };
  };
  return { wireTask, wireBot, wireTrustedApprovalBot };
}
