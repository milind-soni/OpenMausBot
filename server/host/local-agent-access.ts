import { failedTurnTool } from "../../shared/failed-turn.ts";
import { allowsTool, narrowsNativeTools, parseToolScope } from "../../shared/tool-scope.ts";
import { localAgentExecutionAllowed, turnEngine } from "../agents-bridge-switch.ts";
import type { BotRecord, Store } from "../store.ts";

export function createLocalAgentAccess(deps: {
  store: Store; blocked: boolean; botForThread: (botId: string, threadId: string) => BotRecord | null;
  connectorThread: (botId: string, threadId: string) => { group?: { id: string } } | null;
  fullAccess: (botId: string, threadId: string) => boolean; shuttingDown: () => boolean;
  configs: () => Parameters<typeof turnEngine>[1]; instance: (id: string) => Parameters<typeof turnEngine>[0] | null | undefined;
  snapshot: (id: string) => Parameters<typeof turnEngine>[2]; cwd: (botId: string, threadId: string) => string | undefined;
  settings: (bot: BotRecord) => string; cfg: Parameters<typeof localAgentExecutionAllowed>[0];
}) {
  function toolScopeForTurn(botId: string) {
    const bot = deps.store.bot(botId);
    if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
    const parsed = parseToolScope(bot.toolScope);
    if (!parsed.ok) throw Object.assign(new Error("This bot's tool selection is invalid. Open Access settings and save a valid selection before starting a turn."), { status: 409, code: "tool_scope" });
    return parsed.scope;
  }

  function localAgentAllowed(botId: string, threadId: string): boolean {
    const bot = deps.botForThread(botId, threadId);
    if (deps.blocked || !bot || !deps.connectorThread(botId, threadId) || !deps.fullAccess(botId, threadId) ||
        narrowsNativeTools(bot.toolScope) || !allowsTool(bot.toolScope, { kind: "mcp", server: "agents", name: "start_external_agent" })) return false;
    const config = deps.configs()[bot.modelSelection.instanceId]?.config;
    if (config !== undefined && (typeof config !== "object" || config === null || "tools" in config || "disallowedTools" in config)) return false;
    const instance = deps.instance(bot.modelSelection.instanceId);
    const cwd = deps.cwd(botId, threadId);
    return Boolean(instance && cwd && localAgentExecutionAllowed(deps.cfg, turnEngine(instance, deps.configs(), deps.snapshot(instance.instanceId), cwd), deps.settings(bot)));
  }

  function externalAgentNotice(botId: string, threadId: string, message: string): void {
    const source = deps.connectorThread(botId, threadId);
    if (deps.shuttingDown() || !source) return;
    const bot = deps.store.bot(botId);
    deps.store.appendMessage(threadId, { role: "bot", kind: "activity", ...(source.group && bot ? { from: { botId, name: bot.name, color: bot.color } } : {}), tool: failedTurnTool(message) });
    if (source.group) deps.store.patchGroup(source.group.id, { unread: true });
    else deps.store.patchTask(botId, threadId, { unread: true });
  }
  return { toolScopeForTurn, localAgentAllowed, externalAgentNotice };
}
