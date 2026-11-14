import type { ProviderRegistry } from "../harness/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotLifecycleRouteDeps {
  store: Pick<Store, "bots">;
  routines(): RoutineManager | null;
  interruptAllDirectThreads(botId: string): Promise<void>;
  cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ReturnType<ProviderRegistry["get"]>;
  closeOpenApprovals(threadId: string): void;
  deleteBotWithLifecycle(botId: string): Promise<{ status: number; body: unknown }>;
  /** Security: the route is client-scoped, so this is the gate. Why this session may not delete the bot; null when it
   * may. */
  deleteRefusal(auth: RequestAuth, botId: string): string | null;
}

export function createBotLifecycleRoutes(deps: BotLifecycleRouteDeps): RouteHandler {
  const {
    store, interruptAllDirectThreads, cancelDirectTurnDispatch, revokeInternalCapabilitiesForThread, activeGroupTurnForBot,
    cancelGroupTurnOperations, runningTurnInstance, closeOpenApprovals, deleteBotWithLifecycle,
  } = deps;
  return async ({ req, res, path, method, auth, json }) => {
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    if (method === "POST" && path === "/api/local-computer/interrupt") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await Promise.allSettled(
        store.bots
          .filter((bot) => bot.computer === "local")
          .map(async (bot) => {
            await interruptAllDirectThreads(bot.id);
            const routineRun = routines!.activeBotRunForBot(bot.id);
            if (routineRun) {
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              if (routineRun.threadId) {
                revokeInternalCapabilitiesForThread(routineRun.threadId);
              }
              await routines!.cancelRun(routineRun.id);
            }
            const groupTurn = activeGroupTurnForBot(bot.id);
            if (groupTurn) {
              cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
              revokeInternalCapabilitiesForThread(groupTurn.threadId);
              await runningTurnInstance(bot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
              closeOpenApprovals(groupTurn.threadId);
            }
          }),
      );
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const refused = deps.deleteRefusal(auth, m[1]!);
      if (refused) return json(res, 403, { error: refused });
      const result = await deleteBotWithLifecycle(m[1]);
      return json(res, result.status, result.body);
    }
    return PASS;
  };
}
