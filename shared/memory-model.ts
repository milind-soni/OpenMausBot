export interface MemoryModelSelection {
  instanceId: string;
  model: string;
}

export type MemoryModelFailure = "unavailable" | "authentication" | "credits" | "budget" | "forbidden" | "rateLimit" | "timeout" | "request";

export type MemoryModelOutcome =
  | { state: "selected" }
  | { state: "fallback"; used: string }
  | { state: "failed"; reason: MemoryModelFailure };

export type MemoryModelRun = MemoryModelSelection & MemoryModelOutcome;

export interface MemoryModelStatus {
  instanceId: string;
  model?: string;
  last?: MemoryModelRun;
}
