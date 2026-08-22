export interface TelemetryToolSpan {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  ok: boolean;
}

export interface TelemetryTraceEnvelope {
  kind: "trace";
  application: "openmausbot";
  correlationId: string;
  traceId: string;
  botId: string;
  botName: string;
  threadId: string;
  turnId: string;
  engine: string;
  model: string;
  release: string;
  sourceSha: string;
  startedAt: string;
  endedAt: string;
  promptSummary: string;
  responseSummary: string;
  tools: TelemetryToolSpan[];
  usage?: { input: number; output: number };
  outcome: "completed" | "failed" | "cancelled";
  errorSummary?: string;
}

export interface TelemetryErrorEnvelope {
  kind: "error";
  application: "openmausbot";
  correlationId: string;
  traceId?: string;
  botId?: string;
  botName?: string;
  threadId?: string;
  turnId?: string;
  engine?: string;
  model?: string;
  release: string;
  sourceSha: string;
  component: "server" | "driver" | "renderer" | "gateway";
  name: string;
  message: string;
  stack?: string;
  diagnostics?: Record<string, string | number | boolean>;
  at: string;
}

export type TelemetryEnvelope = TelemetryTraceEnvelope | TelemetryErrorEnvelope;
