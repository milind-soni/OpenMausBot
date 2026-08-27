import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export interface RuntimeIdentity {
  /** Platform containment backend, for example a verified service/cgroup backend. */
  backend: string;
  /** Opaque backend-issued identity. A PID or process-group ID is never accepted. */
  opaqueId: string;
  hostGeneration: string;
  verifierVersion: string;
}

export interface ContainmentProof {
  identity: RuntimeIdentity;
  receipt: string;
}

export interface ContainmentBinding {
  runId: string;
  commandId?: string;
  canonicalWorktreePath: string;
  instanceOwner: string;
  instanceFence: number;
  nonce: string;
}

export interface VerifiedContainmentProof {
  verified: true;
  fingerprint: string;
  bindingHash: string;
}

export type ContainmentInspection =
  | { state: "active"; fingerprint: string }
  | { state: "empty"; fingerprint: string }
  | { state: "unknown"; reason: string };

export interface ContainmentPort {
  /** Verification must consult an authority independent from the candidate process. */
  verifyProof(
    proof: ContainmentProof,
    expectedBinding: ContainmentBinding,
  ): Promise<VerifiedContainmentProof | { verified: false; reason: string }>;
  inspect(identity: RuntimeIdentity): Promise<ContainmentInspection>;
  terminateAndWaitEmpty(identity: RuntimeIdentity): Promise<ContainmentInspection>;
}

export function runtimeIdentityProblem(identity: RuntimeIdentity): string | null {
  const backend = identity.backend.trim().toLowerCase();
  if (!backend || backend === "process_group" || backend === "pid" || backend === "setsid") {
    return "unsupported_process_identity";
  }
  if (identity.opaqueId.trim().length < 16) return "runtime_identity_not_opaque";
  if (!identity.hostGeneration.trim() || !identity.verifierVersion.trim()) return "runtime_identity_unversioned";
  return null;
}

export function runtimeIdentityFingerprint(identity: RuntimeIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backend: identity.backend,
        opaqueId: identity.opaqueId,
        hostGeneration: identity.hostGeneration,
        verifierVersion: identity.verifierVersion,
      }),
    )
    .digest("hex");
}

export function containmentBindingHash(binding: ContainmentBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId: binding.runId,
        commandId: binding.commandId ?? null,
        canonicalWorktreePath: binding.canonicalWorktreePath,
        instanceOwner: binding.instanceOwner,
        instanceFence: binding.instanceFence,
        nonce: binding.nonce,
      }),
    )
    .digest("hex");
}

function containmentBindingProblem(binding: ContainmentBinding): string | null {
  if (!binding.runId.trim() || !binding.instanceOwner.trim()) return "containment_binding_identity_missing";
  if (binding.commandId !== undefined && !binding.commandId.trim()) return "containment_binding_command_invalid";
  if (!isAbsolute(binding.canonicalWorktreePath)) return "containment_binding_worktree_not_absolute";
  if (!Number.isInteger(binding.instanceFence) || binding.instanceFence < 1) return "containment_binding_fence_invalid";
  if (binding.nonce.length < 32) return "containment_binding_nonce_invalid";
  return null;
}

export async function verifyContainmentProof(
  port: ContainmentPort,
  proof: ContainmentProof | null,
  expectedBinding: ContainmentBinding,
): Promise<VerifiedContainmentProof | { verified: false; reason: string }> {
  if (!proof) return { verified: false, reason: "containment_proof_missing" };
  const bindingProblem = containmentBindingProblem(expectedBinding);
  if (bindingProblem) return { verified: false, reason: bindingProblem };
  const problem = runtimeIdentityProblem(proof.identity);
  if (problem) return { verified: false, reason: problem };
  const verified = await port.verifyProof(proof, expectedBinding);
  if (!verified.verified) return verified;
  if (verified.fingerprint !== runtimeIdentityFingerprint(proof.identity)) {
    return { verified: false, reason: "containment_identity_mismatch" };
  }
  if (verified.bindingHash !== containmentBindingHash(expectedBinding)) {
    return { verified: false, reason: "containment_binding_mismatch" };
  }
  return verified;
}
