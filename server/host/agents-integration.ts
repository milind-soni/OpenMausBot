import { agentsProxyLaunch } from "../agents-bridge-switch.ts";
import { agentsServerEnv, type AgentsConversation, type AgentsTurn } from "../agents-turn.ts";
import type { BotRecord } from "../store.ts";

export function createAgentsIntegration(deps: {
  bot(id: string): BotRecord | null;
  speaking(botId: string, threadId: string): BotRecord | null;
  room(threadId: string): boolean;
  teamComputer(bot: BotRecord): boolean;
  host(botId: string, speaking: BotRecord | null): AgentsConversation["host"];
  mint(botId: string, threadId: string, turn: AgentsTurn): string;
  port: number;
  savedFiles: boolean;
}) {
  return (botId: string, threadId: string, depth: number, skillAuthoring: boolean, generation: string, roomHandoffId?: string, hostFiles = false) => {
    const bot = deps.bot(botId);
    const speaking = deps.speaking(botId, threadId) ?? bot;
    return { ...agentsProxyLaunch(), env: agentsServerEnv({ threadId, bot: bot ?? { id: botId }, room: deps.room(threadId),
      teamComputer: Boolean(bot && deps.teamComputer(bot)), host: deps.host(botId, speaking) },
    { generation, depth, skillAuthoring, roomHandoffId, ...(hostFiles && deps.savedFiles ? { deliversSavedFiles: true } : {}) },
    (turn) => deps.mint(botId, threadId, turn), `http://127.0.0.1:${deps.port}`) };
  };
}

export function createHooksIntegration(mint: (input: { botId: string; threadId: string; generation: string; depth: 0; kind: "hooks"; skillAuthoring: false; createdBots: 0; openedThreads: 0 }) => string, port: number) {
  return (botId: string, threadId: string, generation: string): { url: string; token: string } => ({
    url: `http://127.0.0.1:${port}`,
    token: mint({ botId, threadId, generation, depth: 0, kind: "hooks", skillAuthoring: false, createdBots: 0, openedThreads: 0 }),
  });
}
