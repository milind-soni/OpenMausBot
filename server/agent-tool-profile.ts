import { hasAnyAgentCapability, type AgentAuthorizationRecord } from "./agent-capabilities.ts";

export type AgentsToolProfile = "full" | "capture" | "evidence";

export function agentsToolProfile({
  commsDepth,
  maxCommsDepth,
  agent,
  /** @deprecated pass agent instead; retained for older adapters. */
  isCaptureOperator,
}: {
  commsDepth: number;
  maxCommsDepth: number;
  agent?: AgentAuthorizationRecord;
  isCaptureOperator?: boolean;
}): AgentsToolProfile | null {
  if (commsDepth < maxCommsDepth) return "full";
  const canIngestSources = agent
    ? hasAnyAgentCapability(agent, "source.ingestion")
    : isCaptureOperator === true;
  return canIngestSources ? "capture" : null;
}
