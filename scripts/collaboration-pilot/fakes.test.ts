import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  containmentBindingHash,
  verifyContainmentProof,
  type ContainmentBinding,
} from "../../server/collaboration/containment.ts";
import { parsePlannerProposal } from "../../server/collaboration/planner.ts";
import type { AgentRunRequest } from "../../server/collaboration/provider-runner.ts";
import type { SandboxedCommandRequest } from "../../server/collaboration/quality-gate.ts";
import { DeterministicPilotFaults } from "./faults.ts";
import {
  AllowlistedPilotCommandRunner,
  createSequentialPilotProposal,
  FixedSequentialPilotPlanner,
  ManualPilotClock,
  pilotCredentialEnvironmentKeys,
  ScriptedPilotAgent,
  ScriptedPilotDiskCapacity,
  ScriptedPilotOutboxDelivery,
  VerifiableFakeContainment,
} from "./fakes.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "openmausbot-pilot-fakes-"));
  scratch.push(path);
  return path;
}

function binding(root: string, suffix = "one"): ContainmentBinding {
  return {
    runId: `run-${suffix}`,
    canonicalWorktreePath: realpathSync(root),
    instanceOwner: "pilot-runtime",
    instanceFence: 1,
    nonce: `pilot-binding-nonce-${suffix.padEnd(32, "0")}`,
  };
}

function agentRequest(root: string, containmentBinding = binding(root)): AgentRunRequest {
  return {
    runId: containmentBinding.runId,
    threadId: "thread-one",
    turnId: "turn-one",
    workItemId: "WI-PILOT",
    planRevision: 1,
    nodeId: "modify-pilot",
    cwd: realpathSync(root),
    objective: "modify fixture",
    instructions: "modify only src/value.txt",
    inputEvidence: ["snapshot:goal"],
    readScope: ["**/*"],
    writeScope: ["src/**"],
    denyScope: [".env*", ".git/**"],
    expectedArtifacts: ["local-candidate"],
    completionDefinition: "fixture changed",
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_ASKPASS: "/usr/bin/false",
      GIT_TERMINAL_PROMPT: "0",
    },
    capabilities: {
      network: false,
      dependencyInstallation: false,
      arbitraryCommands: false,
      gitCommit: false,
    },
    sandbox: {
      filesystemRoot: realpathSync(root),
      readOnlyPaths: [],
      denyGitMetadata: true,
      network: "deny",
    },
    containmentBinding,
    signal: new AbortController().signal,
    registerContainment: async () => undefined,
    emit: () => undefined,
  };
}

function commandRequest(
  root: string,
  argv: readonly [string, ...string[]],
  containmentBinding = { ...binding(root), commandId: "pilot:target" },
): SandboxedCommandRequest {
  return {
    commandId: "pilot:target",
    argv,
    cwd: realpathSync(root),
    environment: { PATH: process.env.PATH, HOME: root, GIT_ASKPASS: "/usr/bin/false" },
    timeoutMs: 2_000,
    maxOutputBytes: 16_000,
    sandbox: { writableRoot: realpathSync(root), deniedPaths: [], network: "deny" },
    containmentBinding,
    registerContainment: async () => undefined,
  };
}

describe("non-production pilot fakes", () => {
  it("provides a fixed valid sequential proposal and a manually controlled clock", () => {
    const proposal = parsePlannerProposal(createSequentialPilotProposal("pilot:target"));
    expect(proposal.nodes.map((node) => node.type)).toEqual(["analyze", "modify", "validate", "report"]);
    expect(proposal.nodes[2]?.commands).toEqual(["pilot:target"]);
    const planner = new FixedSequentialPilotPlanner(proposal);
    expect(planner.propose({ id: "snapshot" } as never)).toEqual(proposal);
    expect(planner.snapshots).toHaveLength(1);

    const clock = new ManualPilotClock(10);
    expect(clock.now()).toBe(10);
    expect(clock.advance(5)).toBe(15);
    expect(clock.now()).toBe(15);
    expect(() => clock.set(14)).toThrow("cannot move backwards");
  });

  it("binds fake containment receipts and rejects replay against another run", async () => {
    const root = temporaryDirectory();
    const containment = new VerifiableFakeContainment();
    const first = binding(root, "first");
    const second = binding(root, "second");
    const proof = containment.issueProof(first);

    await expect(verifyContainmentProof(containment, proof, first)).resolves.toEqual({
      verified: true,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      bindingHash: containmentBindingHash(first),
    });
    await expect(verifyContainmentProof(containment, proof, second)).resolves.toEqual({
      verified: false,
      reason: "pilot_fake_binding_replay",
    });
    expect((await containment.inspect(proof.identity)).state).toBe("active");
    containment.markEmpty(proof.identity);
    expect((await containment.inspect(proof.identity)).state).toBe("empty");
  });

  it("modifies only the allowlisted managed worktree without Git, push, or credential environment", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "value.txt"), "before\n");
    const containment = new VerifiableFakeContainment();
    const agent = new ScriptedPilotAgent({
      containment,
      mutations: [{ path: "src/value.txt", contents: "after\n" }],
    });
    const request = agentRequest(root);
    request.registerContainment = async (proof) => {
      const result = await verifyContainmentProof(containment, proof, request.containmentBinding);
      if (!result.verified) throw new Error(result.reason);
    };

    await expect(agent.run(request)).resolves.toMatchObject({ status: "completed", sandboxEnforced: true });
    expect(readFileSync(join(root, "src", "value.txt"), "utf8")).toBe("after\n");
    expect(agent.evidence).toEqual([
      expect.objectContaining({
        changedPaths: ["src/value.txt"],
        invokedGit: false,
        remotePushes: 0,
      }),
    ]);
    expect(pilotCredentialEnvironmentKeys(request.environment)).toEqual([]);
    expect(await containment.inspect(agent.evidence.length ? containment.issued[0]!.proof.identity : (null as never))).toMatchObject({
      state: "empty",
    });
  });

  it("fails closed when an Agent request carries a credential-like environment key", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "src"));
    const containment = new VerifiableFakeContainment();
    const agent = new ScriptedPilotAgent({ containment, mutations: [] });
    const request = agentRequest(root);
    request.environment.OPENAI_API_KEY = "must-not-cross-boundary";

    await expect(agent.run(request)).rejects.toThrow("pilot_fake_rejected_credential_environment:OPENAI_API_KEY");
    expect(agent.evidence).toEqual([]);
  });

  it("runs only an exact allowlisted shell-free target and records no secret values", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "value.txt"), "after\n");
    const argv = [
      process.execPath,
      "-e",
      "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8')==='after\\n'?0:2)",
    ] as const;
    const containment = new VerifiableFakeContainment();
    const runner = new AllowlistedPilotCommandRunner({
      containment,
      worktreeRoot: root,
      commands: { "pilot:target": { argv } },
    });
    const request = commandRequest(root, argv);
    request.registerContainment = async (proof) => {
      const result = await verifyContainmentProof(containment, proof, request.containmentBinding);
      if (!result.verified) throw new Error(result.reason);
    };

    await expect(runner.run(request)).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
      attestation: { network: "deny", processTreeReaped: true },
    });
    expect(runner.requests).toEqual([
      expect.objectContaining({ commandId: "pilot:target", argv: [...argv] }),
    ]);
    expect(JSON.stringify(runner.requests)).not.toContain("must-not-cross-boundary");
  });

  it("refuses a remote Git push even if a fixture accidentally allowlists it", async () => {
    const root = temporaryDirectory();
    const argv = ["git", "push", "origin", "HEAD"] as const;
    const containment = new VerifiableFakeContainment();
    const runner = new AllowlistedPilotCommandRunner({
      containment,
      worktreeRoot: root,
      commands: { "pilot:target": { argv } },
    });

    await expect(runner.run(commandRequest(root, argv))).rejects.toThrow("pilot_command_executable_denied:git");
    expect(runner.requests).toEqual([]);
  });

  it("returns scripted retry and sent delivery outcomes while counting dedupe attempts", async () => {
    const delivery = new ScriptedPilotOutboxDelivery([
      { outcome: "retryable", error: "pilot_transport_temporary" },
      { outcome: "sent", transportId: "pilot-transport-2" },
    ]);
    const message = {
      id: "outbox-one",
      source: "dingtalk",
      dedupeKey: "pilot-dedupe-one",
      aggregateType: "work_item" as const,
      aggregateId: "WI-PILOT",
      aggregateVersion: 1,
      kind: "primary_status_card" as const,
      payload: {
        type: "primary_status_card" as const,
        headline: "已接收" as const,
        acknowledgement: "Pilot fixture accepted.",
        workItemId: "WI-PILOT",
        workItemStatus: "clarifying",
        workItemVersion: 1,
        association: "created" as const,
      },
    };

    await expect(delivery.deliver(message)).resolves.toEqual({
      outcome: "retryable",
      error: "pilot_transport_temporary",
    });
    await expect(delivery.deliver(message)).resolves.toEqual({ outcome: "sent", transportId: "pilot-transport-2" });
    expect(delivery.calls).toHaveLength(2);
    expect(delivery.attemptsByDedupeKey.get("pilot-dedupe-one")).toBe(2);
  });

  it("scripts deterministic faults and disk transitions", () => {
    const faults = new DeterministicPilotFaults<"before_delivery">({
      before_delivery: [{ kind: "throw", code: "temporary_failure" }, { kind: "return", value: "recover" }],
    });
    expect(() => faults.hit("before_delivery")).toThrow("temporary_failure");
    expect(faults.hit("before_delivery")).toBe("recover");
    expect(faults.hit("before_delivery")).toBeUndefined();
    expect(faults.calls.get("before_delivery")).toBe(3);

    const disk = new ScriptedPilotDiskCapacity([
      { availableBytes: 1n, totalBytes: 100n },
      new Error("probe-failed"),
    ]);
    expect(disk.capacity("/pilot")).toEqual({ availableBytes: 1n, totalBytes: 100n });
    expect(() => disk.capacity("/pilot")).toThrow("probe-failed");
    expect(disk.capacity("/pilot")).toEqual({
      availableBytes: 8_000_000_000n,
      totalBytes: 10_000_000_000n,
    });
  });
});
