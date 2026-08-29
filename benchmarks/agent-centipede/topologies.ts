import type { ActionKind, ScenarioAction } from "./types.ts";

/**
 * Topologies are benchmark fixtures, not product roles.  The same scenario
 * actions must remain runnable when a user renames agents or chooses a
 * different collaboration shape.
 */
export type TopologyKind = "solo" | "independent" | "coordinator-specialists" | "peer-team" | "template";

export type TopologyAgent = {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly ActionKind[];
};

export type AgentTopology = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kind: TopologyKind;
  readonly agents: readonly TopologyAgent[];
  readonly coordinatorId?: string;
  /** The Chief/Capture shape is a compatibility template, never a requirement. */
  readonly optionalTemplate?: boolean;
};

export type TopologySummary = Pick<AgentTopology, "id" | "title" | "kind">;

export type TopologyBenchmarkResult<TResult = unknown> = {
  readonly topology: TopologySummary;
  readonly results: readonly TResult[];
  readonly passed: boolean;
};

const generalistCapabilities: readonly ActionKind[] = [
  "build", "qa", "browser", "windows", "research", "draft", "execute", "auth", "cursor", "unattended", "privacy", "approval",
];

export const RENAMED_SOLO_GENERALIST: AgentTopology = {
  id: "renamed-solo-generalist",
  title: "Renamed solo generalist",
  description: "One user-named agent handles the complete end-to-end task loop.",
  kind: "solo",
  agents: [{ id: "operator-ember", label: "Ember", capabilities: generalistCapabilities }],
};

export const INDEPENDENT_AGENTS: AgentTopology = {
  id: "independent-agents",
  title: "Independent agents",
  description: "Several agents work independently without a coordinator or shared role name.",
  kind: "independent",
  agents: [
    { id: "researcher-north", label: "North", capabilities: ["research", "auth", "cursor"] },
    { id: "builder-west", label: "West", capabilities: ["build", "qa", "windows"] },
    { id: "operator-south", label: "South", capabilities: ["browser", "draft", "execute", "privacy", "approval", "unattended"] },
  ],
};

export const COORDINATOR_SPECIALISTS: AgentTopology = {
  id: "coordinator-specialists",
  title: "Coordinator with specialists",
  description: "A coordinator delegates work to specialists, with no required product-specific names.",
  kind: "coordinator-specialists",
  coordinatorId: "conductor",
  agents: [
    { id: "conductor", label: "Conductor", capabilities: ["draft", "execute", "approval", "unattended"] },
    { id: "research-specialist", label: "Research specialist", capabilities: ["research", "auth", "cursor"] },
    { id: "computer-specialist", label: "Computer specialist", capabilities: ["browser", "windows", "build", "qa", "privacy"] },
  ],
};

export const PEER_TEAM: AgentTopology = {
  id: "peer-team",
  title: "Peer team without a coordinator",
  description: "Peers share the work and make progress without a central coordinator.",
  kind: "peer-team",
  agents: [
    { id: "peer-alpha", label: "Alpha", capabilities: generalistCapabilities },
    { id: "peer-beta", label: "Beta", capabilities: generalistCapabilities },
    { id: "peer-gamma", label: "Gamma", capabilities: generalistCapabilities },
  ],
};

export const CHIEF_CAPTURE_TEMPLATE: AgentTopology = {
  id: "chief-capture-template",
  title: "Chief + Capture template",
  description: "An optional compatibility template for users who want a synthesis agent and a capture agent.",
  kind: "template",
  coordinatorId: "chief",
  optionalTemplate: true,
  agents: [
    { id: "chief", label: "Chief", capabilities: ["draft", "execute", "approval", "research", "unattended"] },
    { id: "capture", label: "Capture", capabilities: ["browser", "auth", "cursor", "privacy", "qa"] },
  ],
};

/** Required topology coverage. The named template is intentionally separate. */
export const DETERMINISTIC_TOPOLOGIES: readonly AgentTopology[] = [
  RENAMED_SOLO_GENERALIST,
  INDEPENDENT_AGENTS,
  COORDINATOR_SPECIALISTS,
  PEER_TEAM,
];

export const OPTIONAL_TOPOLOGY_TEMPLATES: readonly AgentTopology[] = [CHIEF_CAPTURE_TEMPLATE];
export const ALL_TOPOLOGIES: readonly AgentTopology[] = [...DETERMINISTIC_TOPOLOGIES, ...OPTIONAL_TOPOLOGY_TEMPLATES];

export function getTopology(id: string): AgentTopology {
  const topology = ALL_TOPOLOGIES.find((candidate) => candidate.id === id);
  if (!topology) throw new Error(`unknown Agent Centipede benchmark topology: ${id}`);
  return topology;
}

export function summarizeTopology(topology: AgentTopology): TopologySummary {
  return { id: topology.id, title: topology.title, kind: topology.kind };
}

function firstCapableAgent(topology: AgentTopology, action: ScenarioAction): TopologyAgent {
  const agent = topology.agents.find((candidate) => candidate.capabilities.includes(action.kind));
  return agent ?? topology.agents[0] ?? (() => { throw new Error(`topology has no agents: ${topology.id}`); })();
}

/** Deterministic routing makes topology coverage reproducible while allowing
 * every scenario to remain a neutral sequence of capabilities. */
export function routeAction(topology: AgentTopology, action: ScenarioAction, actionIndex: number): string {
  if (topology.kind === "solo") return topology.agents[0]?.id ?? (() => { throw new Error(`topology has no agents: ${topology.id}`); })();
  if (topology.kind === "coordinator-specialists" || topology.kind === "independent" || topology.kind === "template") return firstCapableAgent(topology, action).id;
  return topology.agents[actionIndex % topology.agents.length]?.id ?? (() => { throw new Error(`topology has no agents: ${topology.id}`); })();
}

export function validateTopology(topology: AgentTopology): void {
  if (!topology.id.trim()) throw new Error("topology id is required");
  if (topology.agents.length === 0) throw new Error(`topology has no agents: ${topology.id}`);
  const ids = new Set<string>();
  for (const agent of topology.agents) {
    if (!agent.id.trim() || ids.has(agent.id)) throw new Error(`topology agent ids must be unique: ${topology.id}`);
    ids.add(agent.id);
  }
  if (topology.coordinatorId !== undefined && !ids.has(topology.coordinatorId)) {
    throw new Error(`topology coordinator is not an agent: ${topology.id}`);
  }
}

for (const topology of ALL_TOPOLOGIES) validateTopology(topology);
