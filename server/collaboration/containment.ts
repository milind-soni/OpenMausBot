import { createHash } from "node:crypto";

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

export interface VerifiedContainmentProof {
  verified: true;
  fingerprint: string;
}

export type ContainmentInspection =
  | { state: "active"; fingerprint: string }
  | { state: "empty"; fingerprint: string }
  | { state: "unknown"; reason: string };

export interface ContainmentPort {
  /** Verification must consult an authority independent from the candidate process. */
  verifyProof(proof: ContainmentProof): Promise<VerifiedContainmentProof | { verified: false; reason: string }>;
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

export async function verifyContainmentProof(
  port: ContainmentPort,
  proof: ContainmentProof | null,
): Promise<VerifiedContainmentProof | { verified: false; reason: string }> {
  if (!proof) return { verified: false, reason: "containment_proof_missing" };
  const problem = runtimeIdentityProblem(proof.identity);
  if (problem) return { verified: false, reason: problem };
  const verified = await port.verifyProof(proof);
  if (!verified.verified) return verified;
  if (verified.fingerprint !== runtimeIdentityFingerprint(proof.identity)) {
    return { verified: false, reason: "containment_identity_mismatch" };
  }
  return verified;
}
