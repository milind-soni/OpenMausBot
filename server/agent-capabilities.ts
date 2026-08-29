import { z } from "zod";

/**
 * Capabilities are the stable authorization vocabulary for an agent.  They
 * describe what a bot may do, rather than what its display name happens to
 * be.  A role such as "coordinator" or "collector" is only a convenient
 * bundle of these grants; callers should authorize individual capabilities.
 */
export const AGENT_CAPABILITIES = [
  "agents.coordinate",
  "agents.peer-comms",
  "source.ingestion",
  "source.memory.read",
  "source.memory.write",
  "source.memory.tombstone",
  "world.model.read",
  "world.model.write",
  "connected-apps.read-only",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const agentCapabilitySchema = z.enum(AGENT_CAPABILITIES);

/** A grant is deliberately small and serializable so it can be persisted in
 * bots.json and carried through package migrations without runtime objects. */
export const agentCapabilityGrantSchema = z.object({
  capability: agentCapabilitySchema,
  sourceIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
}).strict();

export type AgentCapabilityGrant = z.infer<typeof agentCapabilityGrantSchema>;

export interface AgentAuthorizationRecord {
  /** Display metadata is intentionally ignored by authorization. */
  name?: unknown;
  /** New persisted grants. Unknown values are treated as absent at the seam. */
  agentGrants?: unknown;
  /** Legacy coordinator flag retained for installation migration. */
  chiefOfStaff?: unknown;
  /** Legacy package metadata retained for installation migration. */
  installedPackage?: unknown;
  /** Legacy playbook metadata retained for installation migration. */
  playbooks?: unknown;
}

const COORDINATOR_GRANTS: readonly AgentCapabilityGrant[] = [
  { capability: "agents.coordinate" },
  { capability: "source.memory.read" },
  { capability: "source.memory.tombstone" },
  { capability: "world.model.read" },
];

const SOURCE_OPERATOR_GRANTS: readonly AgentCapabilityGrant[] = [
  { capability: "source.ingestion" },
  { capability: "source.memory.read" },
  { capability: "source.memory.write" },
  { capability: "source.memory.tombstone" },
  { capability: "world.model.read" },
  { capability: "world.model.write" },
  { capability: "connected-apps.read-only" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasLegacySourceOperatorGrant(input: AgentAuthorizationRecord): boolean {
  if (!isRecord(input.installedPackage) || input.installedPackage.id !== "shane-grok-capture-replica") {
    return false;
  }
  if (!Array.isArray(input.playbooks)) return false;
  return input.playbooks.some((playbook) => isRecord(playbook) && playbook.key === "capture-protocol");
}

function dedupeGrants(grants: readonly AgentCapabilityGrant[]): AgentCapabilityGrant[] {
  const seen = new Set<string>();
  const result: AgentCapabilityGrant[] = [];
  for (const grant of grants) {
    const sourceIds = grant.sourceIds ? [...new Set(grant.sourceIds)] : undefined;
    const key = `${grant.capability}\u001f${sourceIds?.join("\u001f") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sourceIds ? { capability: grant.capability, sourceIds } : { capability: grant.capability });
  }
  return result;
}

/** Keep the legacy coordinator toggle in sync with the capability set.
 * Coordination is additive: an agent may also ingest sources or hold another
 * explicit capability. Disabling it removes only the coordinator bundle and
 * preserves those independent grants.
 */
export function syncCoordinatorRole(
  input: AgentAuthorizationRecord,
  enabled: boolean,
): AgentCapabilityGrant[] {
  const current = resolveAgentGrants(input);
  const coordinatorCapabilities = new Set(COORDINATOR_GRANTS.map((grant) => grant.capability));
  const retained = current.filter((grant) => !coordinatorCapabilities.has(grant.capability));
  return dedupeGrants(enabled ? [...retained, ...COORDINATOR_GRANTS] : retained);
}

/**
 * Resolve grants at the persistence seam. New records use agentGrants. Old
 * records are normalized once from their coordinator flag or reviewed source
 * package, preserving existing installations while making future behavior
 * independent of display names and package labels.
 */
export function resolveAgentGrants(input: AgentAuthorizationRecord): AgentCapabilityGrant[] {
  if (Array.isArray(input.agentGrants)) {
    const parsed = input.agentGrants.flatMap((grant): AgentCapabilityGrant[] => {
      const result = agentCapabilityGrantSchema.safeParse(grant);
      return result.success ? [result.data] : [];
    });
    return dedupeGrants(parsed);
  }
  const legacy: AgentCapabilityGrant[] = [];
  if (input.chiefOfStaff === true) legacy.push(...COORDINATOR_GRANTS);
  if (input.chiefOfStaff !== true && hasLegacySourceOperatorGrant(input)) legacy.push(...SOURCE_OPERATOR_GRANTS);
  return dedupeGrants(legacy);
}

/** Normalize a record before persistence. This is intentionally idempotent. */
export function normalizeAgentGrants(input: AgentAuthorizationRecord): AgentCapabilityGrant[] {
  return resolveAgentGrants(input);
}

export function hasAgentCapability(
  input: AgentAuthorizationRecord,
  capability: AgentCapability,
  sourceId?: string,
): boolean {
  return resolveAgentGrants(input).some((grant) => grant.capability === capability
    && (grant.sourceIds === undefined
      ? true
      : typeof sourceId === "string" && grant.sourceIds.includes(sourceId)));
}

export function hasAgentCapabilityForSources(
  input: AgentAuthorizationRecord,
  capability: AgentCapability,
  sourceIds: readonly string[],
): boolean {
  return sourceIds.length > 0 && sourceIds.every((sourceId) => hasAgentCapability(input, capability, sourceId));
}

export function hasAnyAgentCapability(
  input: AgentAuthorizationRecord,
  capability: AgentCapability,
): boolean {
  return resolveAgentGrants(input).some((grant) => grant.capability === capability);
}

export function isSourceOperator(input: AgentAuthorizationRecord): boolean {
  return hasAnyAgentCapability(input, "source.ingestion");
}

export interface NotificationMirrorDestination extends AgentAuthorizationRecord {
  id: string;
  hidden?: unknown;
}

/** Select the configured destination for phone source events. A destination
 * must explicitly own source.memory.write for google-messages; coordination
 * alone is never enough to receive sensitive phone content. */
export function selectNotificationMirrorDestination<T extends NotificationMirrorDestination>(
  bots: readonly T[],
): T | null {
  return bots.find((bot) => bot.hidden !== true && hasAgentCapability(bot, "source.memory.write", "google-messages")) ?? null;
}
