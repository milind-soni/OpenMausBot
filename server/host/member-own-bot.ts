// A Team Cloud member's own MausBot when they leave (team-member-left.ts `stopBot` and `deleteBot`): every turn of it
// stops, then it is deleted the app's own way.
import type { RoutineManager } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";

export interface MemberOwnBotDeps {
  store(): Pick<Store, "bot" | "patchBot">;
  routines(): Pick<RoutineManager, "activeRunForBot" | "cancelRun"> | null;
  activeGroupTurnForBot(botId: string): { group: { id: string }; threadId: string } | null;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  interruptAllDirectThreads(botId: string): Promise<void>;
  /** Interrupts the bot's running turn in this conversation, if it has one. */
  interruptTurn(bot: BotRecord, threadId: string): Promise<unknown> | undefined;
  closeOpenApprovals(threadId: string): void;
  /** The app's own deletion of a bot (server/index.ts `deleteBotWithLifecycle`). */
  deleteBot(botId: string): Promise<{ status: number; body: { error?: string } }>;
}

export function createMemberOwnBot(deps: MemberOwnBotDeps) {
  return {
    /** Stops every turn of a bot: its chats, its routine run and the room turn it is in. */
    async stopWork(botId: string, cause: string): Promise<void> {
      const bot = deps.store().bot(botId);
      if (!bot) return;
      const routines = deps.routines();
      const run = routines?.activeRunForBot(botId);
      const groupTurn = deps.activeGroupTurnForBot(botId);
      if (groupTurn) {
        deps.cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
        deps.revokeInternalCapabilitiesForThread(groupTurn.threadId);
      }
      await Promise.allSettled([
        deps.interruptAllDirectThreads(botId),
        run ? routines!.cancelRun(run.id, cause) : undefined,
        groupTurn ? deps.interruptTurn(bot, groupTurn.threadId) : undefined,
      ]);
      if (groupTurn) deps.closeOpenApprovals(groupTurn.threadId);
    },
    /** Deletes a member's own MausBot, which stops being their default bot first; it is theirs again if that fails. */
    async remove(botId: string): Promise<boolean> {
      const store = deps.store();
      const bot = store.bot(botId);
      if (!bot) return false;
      store.patchBot(botId, { defaultBot: undefined, sidebarHidden: undefined });
      const result = await deps.deleteBot(botId).catch((error: unknown) => ({ status: 500, body: { error: error instanceof Error ? error.message : String(error) } }));
      if (result.status < 400) return true;
      console.warn(`team member left: could not delete their MausBot ${botId}: ${result.body.error ?? result.status}`);
      if (store.bot(botId)) store.patchBot(botId, { defaultBot: bot.defaultBot, sidebarHidden: bot.sidebarHidden });
      return false;
    },
  };
}
