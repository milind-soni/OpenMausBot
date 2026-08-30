import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContainmentProof } from "../server/collaboration/containment.ts";
import type { AgentRunRequest } from "../server/collaboration/provider-runner.ts";
import {
  DockerCliContainmentSupervisor,
  NodeDockerCommandPort,
} from "../server/collaboration/operations/docker-containment.ts";
import {
  CodexReadOnlyPatchProvider,
  DockerPatchAgent,
  DockerPatchApplier,
} from "../server/collaboration/operations/docker-patch-agent.ts";

const root = "/var/lib/openmausbot-collaboration-pilot";
const runId = `smoke-${randomUUID()}`;
const worktree = join(root, "agent-smoke", runId);
mkdirSync(worktree, { recursive: true, mode: 0o755 });
writeFileSync(join(worktree, "pilot-output.txt"), "pending\n", { mode: 0o644 });

const docker = new NodeDockerCommandPort();
const containment = new DockerCliContainmentSupervisor({
  docker,
  hostGeneration: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  verifierKey: readFileSync("/run/openmausbot-secrets/containment-verifier.key"),
});
const provider = new CodexReadOnlyPatchProvider({
  executable: "/usr/local/bin/codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  exchangeRoot: join(root, "exchange", "provider-smoke"),
  providerUid: 10001,
  providerGid: 10001,
  providerHome: "/home/openmausbot-agent",
  launcher: {
    executable: "/usr/bin/setpriv",
    args: ["--reuid=10001", "--regid=10001", "--clear-groups", "--no-new-privs", "--"],
  },
});
const agent = new DockerPatchAgent({
  provider,
  applier: new DockerPatchApplier({
    docker,
    containment,
    image: "openmausbot-collaboration-pilot:local",
    exchangeRoot: join(root, "exchange", "apply-smoke"),
  }),
});

const binding = {
  runId,
  canonicalWorktreePath: worktree,
  instanceOwner: "integration-smoke",
  instanceFence: 1,
  nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
};
let registered: ContainmentProof | null = null;
const request: AgentRunRequest = {
  runId,
  threadId: `thread-${runId}`,
  turnId: `turn-${runId}`,
  workItemId: "WI-SMOKE",
  planRevision: 1,
  nodeId: "modify",
  cwd: worktree,
  objective: "Set pilot-output.txt to exactly hello pilot followed by one newline.",
  instructions: "Return complete contents only for pilot-output.txt. Do not use git.",
  inputEvidence: ["integration smoke"],
  readScope: ["**/*"],
  writeScope: ["pilot-output.txt"],
  denyScope: [".git", ".git/**", ".env", ".env*", "**/.env*"],
  expectedArtifacts: ["pilot-output.txt"],
  completionDefinition: "pilot-output.txt equals hello pilot followed by one newline",
  environment: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: worktree },
  capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
  sandbox: { filesystemRoot: worktree, readOnlyPaths: [], denyGitMetadata: true, network: "deny" },
  containmentBinding: binding,
  signal: new AbortController().signal,
  registerContainment: async (proof) => {
    const verification = await containment.verifyProof(proof, binding);
    if (!verification.verified) throw new Error(`smoke_containment_rejected:${verification.reason}`);
    registered = proof;
  },
  emit: (event) => process.stderr.write(`${JSON.stringify({ type: event.type, message: event.message })}\n`),
};

try {
  const result = await agent.run(request);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    sandboxEnforced: result.sandboxEnforced,
    containmentRegistered: registered !== null,
    contents: readFileSync(join(worktree, "pilot-output.txt"), "utf8"),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
