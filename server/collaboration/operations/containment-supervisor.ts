import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  containmentBindingHash,
  type ContainmentBinding,
  type ContainmentInspection,
  type ContainmentPort,
  type ContainmentProof,
  runtimeIdentityFingerprint,
  type RuntimeIdentity,
} from "../containment.ts";

const BACKEND = "linux_cgroup_v2_systemd";

export interface CgroupV2Io {
  realpath(path: string): Promise<string>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

class NodeCgroupV2Io implements CgroupV2Io {
  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }
  async read(path: string): Promise<string> {
    return await readFile(path, "utf8");
  }
  async write(path: string, value: string): Promise<void> {
    await writeFile(path, value, "utf8");
  }
  async wait(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function receipt(key: Buffer, identity: RuntimeIdentity, binding: ContainmentBinding): string {
  return createHmac("sha256", key)
    .update(runtimeIdentityFingerprint(identity))
    .update("\0")
    .update(containmentBindingHash(binding))
    .digest("base64url");
}

function populated(events: string): boolean | null {
  const match = events.match(/(?:^|\n)populated\s+([01])(?:\n|$)/u);
  return match ? match[1] === "1" : null;
}

export class LinuxCgroupV2ContainmentSupervisor implements ContainmentPort {
  private readonly root: string;
  private readonly hostGeneration: string;
  private readonly verifierVersion: string;
  private readonly verifierKey: Buffer;
  private readonly io: CgroupV2Io;
  private readonly emptyTimeoutMs: number;

  constructor(input: {
    root: string;
    hostGeneration: string;
    verifierKey: Buffer;
    verifierVersion?: string;
    io?: CgroupV2Io;
    emptyTimeoutMs?: number;
  }) {
    if (!isAbsolute(input.root)) throw new Error("cgroup_root_must_be_absolute");
    if (!input.hostGeneration.trim()) throw new Error("host_generation_required");
    if (input.verifierKey.length < 32) throw new Error("containment_verifier_key_too_short");
    this.root = input.root;
    this.hostGeneration = input.hostGeneration;
    this.verifierKey = Buffer.from(input.verifierKey);
    this.verifierVersion = input.verifierVersion ?? "cgroup-v2-hmac-v1";
    this.io = input.io ?? new NodeCgroupV2Io();
    this.emptyTimeoutMs = input.emptyTimeoutMs ?? 10_000;
  }

  async issueProof(binding: ContainmentBinding, cgroupRelativePath: string): Promise<ContainmentProof> {
    const identity: RuntimeIdentity = {
      backend: BACKEND,
      opaqueId: cgroupRelativePath,
      hostGeneration: this.hostGeneration,
      verifierVersion: this.verifierVersion,
    };
    await this.cgroupPath(identity);
    return { identity, receipt: receipt(this.verifierKey, identity, binding) };
  }

  async verifyProof(proof: ContainmentProof, expectedBinding: ContainmentBinding) {
    if (
      proof.identity.backend !== BACKEND ||
      proof.identity.hostGeneration !== this.hostGeneration ||
      proof.identity.verifierVersion !== this.verifierVersion
    ) {
      return { verified: false as const, reason: "containment_supervisor_identity_mismatch" };
    }
    try {
      await this.cgroupPath(proof.identity);
    } catch {
      return { verified: false as const, reason: "containment_cgroup_unavailable" };
    }
    const expected = Buffer.from(receipt(this.verifierKey, proof.identity, expectedBinding));
    const actual = Buffer.from(proof.receipt);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { verified: false as const, reason: "containment_receipt_invalid" };
    }
    return {
      verified: true as const,
      fingerprint: runtimeIdentityFingerprint(proof.identity),
      bindingHash: containmentBindingHash(expectedBinding),
    };
  }

  async inspect(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    try {
      const path = await this.cgroupPath(identity);
      const state = populated(await this.io.read(join(path, "cgroup.events")));
      if (state === null) return { state: "unknown", reason: "cgroup_events_invalid" };
      return { state: state ? "active" : "empty", fingerprint: runtimeIdentityFingerprint(identity) };
    } catch {
      return { state: "unknown", reason: "cgroup_inspection_failed" };
    }
  }

  async terminateAndWaitEmpty(identity: RuntimeIdentity): Promise<ContainmentInspection> {
    const path = await this.cgroupPath(identity);
    await this.io.write(join(path, "cgroup.kill"), "1");
    const deadline = Date.now() + this.emptyTimeoutMs;
    while (Date.now() <= deadline) {
      const inspected = await this.inspect(identity);
      if (inspected.state === "empty" || inspected.state === "unknown") return inspected;
      await this.io.wait(25);
    }
    return { state: "unknown", reason: "cgroup_did_not_empty" };
  }

  private async cgroupPath(identity: RuntimeIdentity): Promise<string> {
    if (identity.backend !== BACKEND || !/^[a-zA-Z0-9_.\-/]{16,512}$/u.test(identity.opaqueId)) {
      throw new Error("cgroup_identity_invalid");
    }
    const root = await this.io.realpath(this.root);
    const candidate = await this.io.realpath(join(root, identity.opaqueId));
    if (!contained(root, candidate) || candidate === root) throw new Error("cgroup_path_escaped");
    return candidate;
  }
}

export class UnavailableContainmentSupervisor implements ContainmentPort {
  private readonly reason: string;

  constructor(reason = "strong_containment_unavailable") {
    this.reason = reason;
  }
  async verifyProof(_proof: ContainmentProof, _expectedBinding: ContainmentBinding) {
    return { verified: false as const, reason: this.reason };
  }
  async inspect(_identity: RuntimeIdentity): Promise<ContainmentInspection> {
    return { state: "unknown", reason: this.reason };
  }
  async terminateAndWaitEmpty(_identity: RuntimeIdentity): Promise<ContainmentInspection> {
    return { state: "unknown", reason: this.reason };
  }
}

export function ephemeralVerifierKey(): Buffer {
  return randomBytes(32);
}
