export interface AgentProfileSummary {
  generatedAt: number;
  identityAndPreferences: number;
  standingRules: number;
  openWork: number;
  accountBindings: number;
  lastUpdatedAt: number | null;
}

export interface AgentProfileSummaryInput {
  botId: string;
  generatedAt: number;
  activeWorldClaims: number;
  latestWorldObservationAt: number | null;
  work: { readonly obligations: ReadonlyArray<{ readonly updatedAt: number }> };
  rules: ReadonlyArray<{
    readonly ownerId: string;
    readonly approvedAt: number | null;
    readonly createdAt: number;
  }>;
  legacyAllowedTools: readonly string[];
  accountBindingCount: number;
}

/**
 * One compact read model for the everyday profile. Raw memory, permission
 * payloads, account credentials, and work descriptions stay behind their
 * owning modules; the UI learns only safe counts and freshness.
 */
export function agentProfileSummary(input: AgentProfileSummaryInput): AgentProfileSummary {
  const ownedRules = input.rules.filter((rule) => rule.ownerId === input.botId);
  const timestamps = [
    input.latestWorldObservationAt,
    ...input.work.obligations.map((obligation) => obligation.updatedAt),
    ...ownedRules.map((rule) => rule.approvedAt ?? rule.createdAt),
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    generatedAt: input.generatedAt,
    identityAndPreferences: Math.max(0, input.activeWorldClaims),
    standingRules: ownedRules.length + new Set(input.legacyAllowedTools).size,
    openWork: input.work.obligations.length,
    accountBindings: Math.max(0, input.accountBindingCount),
    lastUpdatedAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
  };
}
