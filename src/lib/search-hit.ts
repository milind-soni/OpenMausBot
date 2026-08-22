/** One /api/search hit, resolved to the bot or room that owns it. */
export interface SearchHit {
  botId?: string;
  groupId?: string;
  name: string;
  threadId: string;
  task?: string;
  messageId: string;
  role: string;
  kind: string;
  from?: string;
  at: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  onActivePath: boolean;
}
