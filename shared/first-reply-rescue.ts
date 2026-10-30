// A chat whose AI has said nothing yet, some seconds into the turn, gets one
// notice row with what the person can do about it. The row's tool name is a
// whole plain sentence, so a client that only prints tool names (the phones)
// still reads it; this payload is what lets the desktop draw its buttons.

export interface FirstReplyRescue {
  /** The bot whose turn is waiting: its AI is what "Switch AI" changes. */
  botId: string;
  threadId: string;
  /** The turn this row is about: its buttons never reach another one. */
  turnId: string;
  /** The person's message that turn answers, to send again on another AI. */
  requestMessageId?: string;
  /** The AI the turn waits on, as its instance id and the name a person knows it by. */
  instanceId: string;
  ai: string;
  /** A room turn: the room it is running in. */
  groupId?: string;
  /** The AI has started answering: the row no longer asks anything of the person. */
  settled?: true;
  /** Its turn ended (or gave way to the next) without an answer: the row is history, with no live buttons. */
  over?: true;
}

/** The waiting row's words, for clients that print the tool name. */
export function firstReplyWaitingName(botName: string, ai: string): string {
  return `notice: ${botName} hasn't heard back from ${ai} yet.`;
}

/** The same row once its turn ended without an answer: history, true as it stands. */
export function firstReplyOverName(botName: string, ai: string): string {
  return `notice: ${botName} didn't hear back from ${ai}.`;
}

/** The same row once the AI's first output arrived. */
export function firstReplySettledName(ai: string): string {
  return `notice: ${ai} answered after a slow start.`;
}
