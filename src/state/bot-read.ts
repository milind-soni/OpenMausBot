import { api, ApiError } from "./api";
import type { BotAnnouncement } from "./store";
import { NO_SUCH_BOT } from "../../shared/bot-read";

type Read = <T>(path: string, init?: { signal?: AbortSignal }) => Promise<T>;

/** One bot as the server holds it, with its newest `messages` in the shown conversation; null when it is gone. */
export async function readOneBot(botId: string, messages: number, signal?: AbortSignal, read: Read = api): Promise<BotAnnouncement | null> {
  const result = (bot?: BotAnnouncement) => {
    if (!bot) return null;
    if (messages !== 0) return bot;
    const { messages: _messages, hasMore: _more, activeLeafId: _leaf, ...settings } = bot;
    return settings;
  };
  try {
    const { bot } = await read<{ bot?: BotAnnouncement }>(`/api/bots/${encodeURIComponent(botId)}?messages=${messages}`, { signal });
    return result(bot);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    if (error.body?.error === NO_SUCH_BOT) return null;
  }
  const { bots } = await read<{ bots: BotAnnouncement[] }>(`/api/bots?messages=${messages}`, { signal });
  return result(bots.find((candidate) => candidate.id === botId));
}
