/** Read-only studio metadata. Conversation content stays in its existing routes. */
export type StudioOutcome = "completed" | "failed" | "interrupted";

export interface StudioTarget {
  botId: string;
  threadId: string;
  messageId?: string;
}

export interface StudioResult extends StudioTarget {
  id: string;
  turnId: string;
  status: StudioOutcome;
  finishedAt: number;
  title: string;
  handoffId?: string;
  sourceBotId?: string;
  sourceThreadId?: string;
}

export interface StudioAttention extends StudioTarget {
  id: string;
  requestId: string;
  at: number;
  kind: "question" | "approval" | "computer";
}

export interface StudioHandoff {
  id: string;
  sourceBotId: string;
  targetBotId: string;
  sourceThreadId: string;
  sourceMessageId?: string;
  targetThreadId?: string;
  messageId?: string;
  state: "queued" | "running" | StudioOutcome | "denied" | "dropped";
  at: number;
}

export interface StudioThread {
  threadId: string;
  title: string;
  busy: boolean;
  activity: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  queued: number;
}

export interface StudioStation {
  botId: string;
  threads: StudioThread[];
  threadCount: number;
  attentionCount: number;
}

export interface StudioPage<T> {
  items: T[];
  total: number;
  offset: number;
}

export interface StudioSnapshot {
  workspaceId: string;
  revision: string;
  serverTime: number;
  room: string;
  rooms: Array<{ id: string; botIds: string[]; attentionCount: number }>;
  stations: StudioStation[];
  attention: StudioPage<StudioAttention>;
  handoffs: StudioPage<StudioHandoff>;
  results: StudioPage<StudioResult>;
}
