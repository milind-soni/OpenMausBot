/** The bot that opened a thread on itself or a teammate. */
export interface TaskOpenedBy {
  botId: string;
  name: string;
  delegationId?: string;
  /** What kind of conversation the opener made this: "pair" is the one
   * durable conversation between two bots; "work" closes itself once its
   * result has been reported. */
  kind?: "pair" | "work";
  /** coordinate_bots opened it with thread "new" for one hand-off: it closes, and leaves the sidebar, once its result is
   * back (server/host/finished-work.ts). start_thread never sets it. */
  oneShot?: true;
  /** Epoch ms this thread closes at, set when the person stopped the work handed to it: a new message there before then
   * takes it off and keeps the thread open. Older servers ignore it. */
  closesAt?: number;
  /** The burst this thread is one part of: it is listed under that burst's card. */
  burstId?: string;
  /** The opener's own conversation this "work" thread was opened from.
   * Everything that conversation later sends this bot continues here. */
  threadId?: string;
  /** A parallel room job's thread: `threadId` is the room thread it came from, and the member must stay in that room. */
  roomLane?: true;
  /** Security invariant: harness-set only when the opening turn could use the owner's lent computer. */
  forOwner?: true;
  at: number;
}

/** The bot that closed a thread it opened (or one of its own). */
export interface TaskClosedBy {
  botId: string;
  name: string;
  at: number;
}

/** The completed message whose visible history seeded an independent conversation. */
export interface ForkOrigin {
  threadId: string;
  messageId: string;
}
