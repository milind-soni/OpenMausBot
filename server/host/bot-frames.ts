/** Which streams a bot frame goes to: those that said they take frames carrying only the changed thread, or the rest. */
export type BotFrameForm = "thread" | "whole";

export const takesFrame = (threadFrames: boolean, form: BotFrameForm | undefined): boolean =>
  form === undefined || (form === "thread") === threadFrames;

export interface BotFramesDeps<Bot> {
  broadcast(payload: Record<string, unknown>, options?: { frames: BotFrameForm }): void;
  /** The bot as clients see it; with `onlyThreadId`, carrying that thread alone. */
  wire(bot: Bot, onlyThreadId?: string): object;
  /** Whether a stream is open that takes only whole frames. */
  wholeListeners(): boolean;
  lastSeq(): number;
}

/** A change to one thread of a bot is sent as the bot with that thread alone (`tasksPartial`) to streams that asked for
 * it. Any other stream gets the whole bot, as before; with none open, the whole bot is not built at all. */
export function createBotFrames<Bot extends { tasks?: ReadonlyArray<{ threadId: string }> }>(deps: BotFramesDeps<Bot>) {
  let wholeSkippedAt = 0;
  return {
    send(bot: Bot, threadId?: string, extra: object = {}): void {
      if (threadId === undefined || !bot.tasks?.some((task) => task.threadId === threadId)) {
        deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot), ...extra } });
        return;
      }
      deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot, threadId), ...extra }, tasksPartial: true }, { frames: "thread" });
      if (deps.wholeListeners()) deps.broadcast({ kind: "bot", bot: { ...deps.wire(bot), ...extra } }, { frames: "whole" });
      else wholeSkippedAt = deps.lastSeq();
    },
    /** A stream that takes only whole frames cannot resume across one that was never built: it loads everything again. */
    resumable: (since: number, threadFrames: boolean): boolean => threadFrames || wholeSkippedAt <= since,
  };
}
