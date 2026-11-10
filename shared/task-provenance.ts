/** The bot that opened a thread on itself or a teammate. */
export interface TaskOpenedBy {
  botId: string;
  name: string;
  delegationId?: string;
  /** What kind of conversation the opener made this: "pair" is the one
   * durable conversation between two bots; "work" closes itself once its
   * result has been reported. */
  kind?: "pair" | "work";
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
