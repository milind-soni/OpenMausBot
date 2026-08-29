/** One /api/search hit, resolved to the bot or room that owns it. */
export interface SearchHit {
  /** Conversation text, or a durable product record surfaced by search. */
  category?: "conversation" | "task" | "decision" | "artifact";
  botId?: string;
  groupId?: string;
  name: string;
  threadId: string;
  task?: string;
  messageId: string;
  workId?: string;
  role: string;
  kind: string;
  from?: string;
  at: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  onActivePath: boolean;
}
