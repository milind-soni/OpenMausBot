// The peer-agent comms cluster -- the internal-capability bearer
// predicates, the workspace sidebar/group-task schemas, the spawned proxy
// paths and the agents proxy integration -- extracted verbatim from
// index.ts. index.ts calls createPeerAgentComms at the region's original
// site (the "peer-agent comms wiring" banner) and rebinds the names from
// its result. The capability store, generation registries and the
// mint/revoke helpers stay in ./internal-capabilities.ts; the local-VM
// lease names internalCapabilityIsActive reads are produced by the
// computer lifecycle wired further down index.ts, so they cross as thunks
// resolved at call time.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { sharedComputersEnabled } from "./config.ts";
import {
  activeInternalGenerationByThread,
  computerSelectionTurns,
  internalCapabilities,
  mintInternalCapability,
} from "./internal-capabilities.ts";
import { cfg, teamComputerTurns } from "./runtime.ts";
import type { InternalCapability } from "./routes/internal.ts";
import type { createComputerLifecycle } from "./computer-lifecycle.ts";

type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;

/** Everything the peer-agent comms cluster reads from its host. PORT is a
 * const index.ts binds above the region's site; the lateBound slice reads
 * computer-lifecycle names index.ts binds below it, resolved at call
 * time. */
export interface PeerAgentCommsDeps {
  helpers: {
    PORT: number;
  };
  lateBound: {
    localVmOwnerBusy(): ComputerLifecycle["localVmOwnerBusy"];
    localVmLeaseFor: ComputerLifecycle["localVmLeaseFor"];
    localVmThreadTargets(): ComputerLifecycle["localVmThreadTargets"];
  };
}

export function createPeerAgentComms(deps: PeerAgentCommsDeps) {
  const { PORT } = deps.helpers;
  const { localVmOwnerBusy, localVmLeaseFor, localVmThreadTargets } = deps.lateBound;

// The capability store, generation registries, and the mint/revoke helpers
// live in ./internal-capabilities.ts. The bearer predicates stay here:
// internalCapabilityIsActive also reads the team-computer turn table and
// the local VM lease pool, which remain index-local.

/** Resolve a high-entropy bearer to its immutable server-side claims.
 * Constant-time comparisons keep the check independent of matching prefix
 * length; only capabilities for currently active turns are retained. */
function authorizedInternalCapability(header: string | string[] | undefined): InternalCapability | null {
  const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
  for (const [token, capability] of internalCapabilities) {
    if (!internalCapabilityIsActive(capability)) {
      internalCapabilities.delete(token);
      continue;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return capability;
  }
  return null;
}

function internalCapabilityIsActive(capability: InternalCapability): boolean {
  const switching = computerSelectionTurns.get(capability.threadId);
  if ((capability.kind === "computer" || capability.kind === "browser") &&
      switching?.generation === capability.generation && switching.selected) return false;
  if (capability.teamComputerId) {
    const pinned = teamComputerTurns.get(capability.threadId);
    if (pinned?.computerId !== capability.teamComputerId || pinned.owner.generation !== capability.generation ||
        pinned.botId !== capability.botId) return false;
  }
  if (capability.localVmTarget) {
    const owner = localVmLeaseFor(capability.localVmTarget).current(localVmOwnerBusy());
    if (localVmThreadTargets().get(capability.threadId) !== capability.localVmTarget ||
        owner?.threadId !== capability.threadId || owner.botId !== capability.botId) return false;
  }
  return (
    capability.orphanExpiresAt > Date.now() &&
    activeInternalGenerationByThread.get(capability.threadId) === capability.generation
  );
}
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets NO agents tool, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
const MAX_WORKSPACE_BOTS = 100;
const createSidebarSectionSchema = z.object({
  name: z.string(),
  botIds: z.array(z.string().regex(/^[\w-]+$/)).max(MAX_WORKSPACE_BOTS).default([]),
}).strict();
const createGroupTaskRequestSchema = z.object({ title: z.string().optional() });
// Resolved from the server root — see server/proxy-paths.ts. This descending
// path happened to survive bundling, but it goes through the same anchor so
// there is exactly one way proxies are located.
const agentsProxyPath = SPAWNED_PROXIES.agents;
const phoneProxyPath = SPAWNED_PROXIES.phone;
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(
  botId: string,
  threadId: string,
  depth: number,
  skillAuthoring: boolean,
  generation: string,
  roomHandoffId?: string,
  roomCoordination = false,
  ownThreadCreation = false,
) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth,
    kind: "agents",
    skillAuthoring,
    createdBots: 0,
    openedThreads: 0,
    roomHandoffId,
    roomCoordination,
    ownThreadCreation,
  });
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_THREAD_ID: threadId,
      OMB_COMMS_TOKEN: token,
      OMB_TURN_DEPTH: String(depth),
      OMB_TURN_GENERATION: generation,
      OMB_ROOM_TURN: roomCoordination ? "1" : "0",
      OMB_OWN_THREAD_CREATION: ownThreadCreation ? "1" : "0",
      OMB_SKILL_AUTHORING_ENABLED: skillAuthoring ? "1" : "0",
      // The shared-computer tools are advertised only while the workspace
      // gate is on; the routes behind them refuse regardless.
      OMB_SHARED_COMPUTERS_ENABLED: sharedComputersEnabled(cfg) ? "1" : "0",
    },
  };
}
  return {
    authorizedInternalCapability, internalCapabilityIsActive,
    MAX_COMMS_DEPTH, MAX_WORKSPACE_BOTS,
    createSidebarSectionSchema, createGroupTaskRequestSchema,
    phoneProxyPath, AGENTS_NODE_FLAG, agentsIntegration,
  };
}
