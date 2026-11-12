import { liveHistoryFrom, LiveSessionError, type LiveBot, type LiveHistoryMessage } from "../live-call.ts";
import { sinceFreshStart } from "../fresh-start.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";

export function createLiveSessionContext({ store, sessions }: {
  store: Pick<Store, "bot" | "activePath">;
  sessions: Pick<SessionRegistry, "isLive">;
}) {
  function liveBotFor(botId: string): LiveBot {
    const bot = store.bot(botId);
    if (!bot) throw new LiveSessionError("That bot no longer exists.", 404);
    return { name: bot.name, title: bot.title, description: bot.description };
  }
  function liveHistoryFor(threadId: string): LiveHistoryMessage[] {
    return liveHistoryFrom(sinceFreshStart(store.activePath(threadId)));
  }
  /** A signed-out or removed person's call must not keep reaching the bot or spending the key. */
  function liveSignedIn(auth: RequestAuth): boolean {
    return auth.kind !== "session" || sessions.isLive(auth.session.id);
  }
  return { liveBotFor, liveHistoryFor, liveSignedIn };
}
