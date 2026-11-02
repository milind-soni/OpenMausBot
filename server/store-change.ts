import type { WireMessage } from "../shared/wire.ts";

export type StoreChange =
  | { type: "sections" }
  | { type: "private.tasks.saved" }
  | { type: "message"; threadId: string; message: WireMessage }
  | { type: "message.patch"; threadId: string; message: WireMessage }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  /** The fleet was reordered as a whole; the broadcast carries every id in its new place. */
  | { type: "bots.order" }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };
