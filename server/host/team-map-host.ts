// GET /api/team-map, wired for the server: who works with whom, the hand-offs in flight, each open session and the
// past day's finished turns, for the bots, rooms and conversations the asking person may see.
// Security: prompts and replies never leave their transcripts. This projection carries only ids, relationships, labels
// and timestamps, and a conversation `visible.hides` (another member's private chat) adds no session, edge or count.
import type { VisibleSet } from "../bot-visibility.ts";
import type { LiveHandoffEdge } from "../coordinator.ts";
import type { Store } from "../store.ts";
import { teamMapSessions } from "../team-map-sessions.ts";
import { readUsageCached } from "../usage-ledger.ts";

const DAY_MS = 24 * 60 * 60_000;

export interface TeamMapHostDeps {
  dataDir: string;
  store(): Pick<Store, "bots" | "groups" | "tasks" | "groupByThread" | "botByThread" | "taskByThread">;
  liveEdges(): LiveHandoffEdge[];
  /** When the conversation last had a line, from the message database. */
  lastRowAt(threadId: string): number | undefined;
  /** Whether the engine instance runs on a subscription plan rather than per-token billing. */
  onPlan(instanceId: string): boolean;
}

export type TeamMapVisibility = Pick<VisibleSet, "bot" | "thread" | "group" | "hides">;

export function createTeamMapHost(deps: TeamMapHostDeps) {
  return {
    view(visible: TeamMapVisibility) {
      const store = deps.store();
      const now = Date.now();
      const mapped = new Set(store.bots.filter((bot) => !bot.hidden && visible.bot(bot.id)).map((bot) => bot.id));
      const sessionBots = store.bots
        .filter((bot) => mapped.has(bot.id))
        .map((bot) => ({ id: bot.id, modelSelection: bot.modelSelection, tasks: store.tasks(bot.id).filter((task) => task.archivedAt === undefined && visible.thread(task.threadId)) }));
      const collaborations = store.groups
        .filter(
          (group) =>
            group.dm === true &&
            group.memberIds.length === 2 &&
            group.memberIds.every((botId) => mapped.has(botId)),
        )
        .map((group) => ({
          groupId: group.id,
          botIds: [group.memberIds[0], group.memberIds[1]] as [string, string],
          lastAt: deps.lastRowAt(group.threadId) ?? group.createdAt,
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
      const roomBusy = store.groups
        .filter((group) => group.busyBotId && mapped.has(group.busyBotId) && visible.group(group.id) && !visible.hides(group.threadId))
        .map((group) => ({ botId: group.busyBotId!, threadId: group.threadId, title: group.name, groupId: group.id, startedAt: group.turnStartedAt }));
      const handoffs = deps.liveEdges().filter((edge) =>
        mapped.has(edge.sourceBotId)
        && mapped.has(edge.targetBotId)
        && (!edge.groupId || visible.group(edge.groupId))
        && !visible.hides(edge.threadId));
      const links = (state: "queued" | "running") =>
        handoffs.flatMap(({ state: edgeState, createdAt: _createdAt, ...link }) => edgeState === state ? [link] : []);
      const queued = links("queued");
      const queuedSince = handoffs.filter((edge) => edge.state === "queued");
      const doneLast24h = readUsageCached(deps.dataDir, { from: new Date(now - DAY_MS), to: new Date(now) })
        .filter((row) => mapped.has(row.botId) && row.turnId !== undefined && !visible.hides(row.threadId)).length;
      return {
        collaborations,
        queued,
        running: links("running"),
        ...teamMapSessions({
          bots: sessionBots,
          queued: queuedSince,
          roomBusy,
          lastOutputAt: deps.lastRowAt,
          groupIdOf: (threadId) => store.groupByThread(threadId)?.id,
          visibleGroup: (groupId) => visible.group(groupId),
          createdAt: (threadId) => {
            const owner = store.botByThread(threadId);
            return owner ? store.taskByThread(owner.id, threadId)?.createdAt : undefined;
          },
          onPlan: deps.onPlan,
          doneLast24h,
          now,
        }),
      };
    },
  };
}
