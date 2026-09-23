export interface PromptUsage {
  input: number | null;
  cached: number | null;
  uncached: number | null;
  output: number | null;
}
export interface PromptCapture {
  id: string;
  threadId: string;
  botId?: string;
  turnId?: string;
  provider: string;
  kind: "agent-input" | "api-request";
  sentAt: string;
  status: "sending" | "completed" | "failed" | "interrupted";
  body: unknown;
  endpoint?: string;
  httpStatus?: number;
  responseHeaders?: Record<string, string>;
  usage?: PromptUsage;
  durationMs?: number;
  error?: string;
  omitted?: boolean;
}
