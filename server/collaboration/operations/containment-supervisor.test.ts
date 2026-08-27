import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import { containmentBindingHash, type ContainmentBinding } from "../containment.ts";
import {
  type CgroupV2Io,
  LinuxCgroupV2ContainmentSupervisor,
  UnavailableContainmentSupervisor,
} from "./containment-supervisor.ts";

class FakeCgroupIo implements CgroupV2Io {
  readonly events = new Map<string, string>();
  readonly kills: string[] = [];
  async realpath(path: string): Promise<string> {
    return posix.resolve(path);
  }
  async read(path: string): Promise<string> {
    const value = this.events.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }
  async write(path: string, value: string): Promise<void> {
    this.kills.push(`${path}:${value}`);
    if (path.endsWith("/cgroup.kill")) this.events.set(path.replace(/cgroup\.kill$/u, "cgroup.events"), "populated 0\n");
  }
  async wait(): Promise<void> {}
}

function binding(runId = "RUN-1"): ContainmentBinding {
  return {
    runId,
    canonicalWorktreePath: "/managed/worktrees/WI-1/modify",
    instanceOwner: "headless-instance",
    instanceFence: 7,
    nonce: "opaque-binding-nonce-00000000000000000001",
  };
}

describe("Linux cgroup v2 containment supervisor", () => {
  it("cryptographically binds proof to run/worktree/fence/nonce and rejects replay", async () => {
    const io = new FakeCgroupIo();
    const root = "/sys/fs/cgroup/openmausbot";
    const scope = "openmausbot-run-0001.scope";
    io.events.set(`${root}/${scope}/cgroup.events`, "populated 1\n");
    const supervisor = new LinuxCgroupV2ContainmentSupervisor({
      root,
      hostGeneration: "boot-generation-1",
      verifierKey: Buffer.alloc(32, 7),
      io,
    });
    const proof = await supervisor.issueProof(binding(), scope);
    await expect(supervisor.verifyProof(proof, binding())).resolves.toMatchObject({
      verified: true,
      bindingHash: containmentBindingHash(binding()),
    });
    await expect(supervisor.verifyProof(proof, binding("RUN-REPLAY"))).resolves.toEqual({
      verified: false,
      reason: "containment_receipt_invalid",
    });
  });

  it("kills and waits for the whole cgroup, including escaped process-group descendants", async () => {
    for (const scenario of ["setsid", "double-fork", "leader-exited", "service-restart"]) {
      const io = new FakeCgroupIo();
      const root = "/sys/fs/cgroup/openmausbot";
      const scope = `openmausbot-${scenario}-0001.scope`;
      io.events.set(`${root}/${scope}/cgroup.events`, "populated 1\n");
      const supervisor = new LinuxCgroupV2ContainmentSupervisor({
        root,
        hostGeneration: "boot-generation-1",
        verifierKey: Buffer.alloc(32, 8),
        io,
      });
      const proof = await supervisor.issueProof(binding(`RUN-${scenario}`), scope);
      await expect(supervisor.inspect(proof.identity)).resolves.toMatchObject({ state: "active" });
      await expect(supervisor.terminateAndWaitEmpty(proof.identity)).resolves.toMatchObject({ state: "empty" });
      expect(io.kills).toEqual([`${root}/${scope}/cgroup.kill:1`]);
    }
  });

  it("fails closed on unsupported hosts and never treats process groups as containment", async () => {
    const unavailable = new UnavailableContainmentSupervisor("platform_has_no_strong_containment");
    const proof = {
      identity: {
        backend: "process_group",
        opaqueId: "1234567890123456",
        hostGeneration: "boot",
        verifierVersion: "v1",
      },
      receipt: "untrusted",
    };
    await expect(unavailable.verifyProof(proof, binding())).resolves.toEqual({
      verified: false,
      reason: "platform_has_no_strong_containment",
    });
    await expect(unavailable.inspect(proof.identity)).resolves.toEqual({
      state: "unknown",
      reason: "platform_has_no_strong_containment",
    });
  });
});
