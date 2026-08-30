import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ContainmentProof } from "../containment.ts";
import type { AgentRunRequest } from "../provider-runner.ts";
import {
  CodexReadOnlyPatchProvider,
  DockerPatchApplier,
  DockerPatchAgent,
  type PatchApplierPort,
  type ReadOnlyPatchProvider,
  validateDockerPatchChanges,
} from "./docker-patch-agent.ts";

function request(): AgentRunRequest {
  return {
    runId: "run-1",
    threadId: "thread-1",
    turnId: "turn-1",
    workItemId: "WI-1",
    planRevision: 1,
    nodeId: "modify",
    cwd: "/worktrees/run-1",
    objective: "write hello pilot",
    instructions: "change only src/output.txt",
    inputEvidence: ["requested"],
    readScope: ["**/*"],
    writeScope: ["src/**"],
    denyScope: [".git/**", ".env*"],
    expectedArtifacts: ["src/output.txt"],
    completionDefinition: "file contains hello pilot",
    environment: { PATH: "/usr/bin:/bin" },
    capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: "/worktrees/run-1", readOnlyPaths: ["/repo"], denyGitMetadata: true, network: "deny" },
    containmentBinding: {
      runId: "run-1",
      canonicalWorktreePath: "/worktrees/run-1",
      instanceOwner: "owner",
      instanceFence: 1,
      nonce: "n".repeat(32),
    },
    signal: new AbortController().signal,
    registerContainment: vi.fn(),
    emit: vi.fn(),
  };
}

const proof: ContainmentProof = {
  identity: {
    backend: "docker_cgroup_v2",
    opaqueId: "a".repeat(64),
    hostGeneration: "boot-1",
    verifierVersion: "docker-cgroup-v2-hmac-v1",
  },
  receipt: "receipt",
};

describe("Docker patch Agent", () => {
  it("keeps the provider read-only and delegates only validated writes to Docker", async () => {
    const provider: ReadOnlyPatchProvider = {
      propose: vi.fn(async () => ({
        status: "completed" as const,
        summary: "done",
        changes: [{ path: "src/output.txt", contents: "hello pilot\n" }],
        readOnlyEnforced: true as const,
      })),
      interrupt: vi.fn(),
    };
    const applier: PatchApplierPort = { apply: vi.fn(async () => proof), interrupt: vi.fn() };
    const input = request();
    await expect(new DockerPatchAgent({ provider, applier }).run(input)).resolves.toMatchObject({
      status: "completed",
      sandboxEnforced: true,
      containmentProof: proof,
    });
    expect(applier.apply).toHaveBeenCalledWith(input, [{ path: "src/output.txt", contents: "hello pilot\n" }]);
  });

  it("rejects provider paths outside the declared write scope before Docker", () => {
    expect(() => validateDockerPatchChanges(request(), [{ path: "README.md", contents: "no" }])).toThrow(
      "provider_patch_path_denied",
    );
    expect(() => validateDockerPatchChanges(request(), [{ path: ".env", contents: "secret" }])).toThrow(
      "provider_patch_path_denied",
    );
  });

  it("does not claim a sandbox when the provider cannot prove read-only mode", async () => {
    const provider: ReadOnlyPatchProvider = {
      propose: vi.fn(async () => ({
        status: "needs_configuration" as const,
        summary: "provider unavailable",
        changes: [],
        readOnlyEnforced: true as const,
      })),
      interrupt: vi.fn(),
    };
    const applier: PatchApplierPort = { apply: vi.fn(async () => proof), interrupt: vi.fn() };
    await expect(new DockerPatchAgent({ provider, applier }).run(request())).resolves.toMatchObject({
      status: "needs_configuration",
      sandboxEnforced: true,
    });
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it("removes the abort listener when Docker patch application fails", async () => {
    const input = request();
    const remove = vi.spyOn(input.signal, "removeEventListener");
    const docker = {
      run: vi.fn(async (args: readonly string[]) => {
        if (args[0] === "create") return { exitCode: 0, stdout: Buffer.from("a".repeat(64)), stderr: Buffer.alloc(0) };
        if (args[0] === "wait") return { exitCode: 0, stdout: Buffer.from("1\n"), stderr: Buffer.alloc(0) };
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }),
    };
    const containment = {
      labels: vi.fn(() => []),
      issueProof: vi.fn(async () => proof),
      inspect: vi.fn(async () => ({ state: "empty" as const })),
    };
    const applier = new DockerPatchApplier({
      docker,
      containment: containment as never,
      image: "pilot:local",
      exchangeRoot: mkdtempSync(join(tmpdir(), "docker-patch-agent-")),
    });

    await expect(applier.apply(input, [{ path: "src/output.txt", contents: "hello\n" }])).rejects.toThrow(
      "docker_patch_apply_failed",
    );
    expect(docker.run).toHaveBeenCalledWith(
      expect.arrayContaining(["--entrypoint", "/bin/sh", "pilot:local"]),
      expect.any(Object),
    );
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("force-kills a provider process that ignores SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "docker-provider-timeout-"));
    const executable = join(directory, "ignore-term.mjs");
    writeFileSync(
      executable,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    const provider = new CodexReadOnlyPatchProvider({
      executable,
      exchangeRoot: join(directory, "exchange"),
      timeoutMs: 20,
      forceKillGraceMs: 20,
    });

    await expect(provider.propose(request())).rejects.toThrow("codex_patch_provider_failed");
  });
});
