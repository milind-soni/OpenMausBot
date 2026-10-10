// This versions only the hosted consume/check wire contract, not the app release.
export const HOSTED_CONTRACT_VERSION = 1;
export const HOSTED_CONTRACT_HEADER = "x-omb-hosted-contract-version";
export const HOSTED_CONTRACT_METADATA = Object.freeze({
  contractVersion: HOSTED_CONTRACT_VERSION,
  supportedContractVersions: Object.freeze([HOSTED_CONTRACT_VERSION]),
  legacyPolicy: "legacy-v1",
});
export const HOSTED_CONTRACT_MISMATCH = "HOSTED_CONTRACT_MISMATCH";
export const HOSTED_CONTRACT_ERROR = "Admin and workspace runtime versions are incompatible. Ask your administrator to update the deployment.";

/** legacy-v1 accepts an omitted version only for the existing v1 payload.
 * Remove this transition at protocol v2; never retry an unsupported explicit
 * version without its version field or infer compatibility from app versions. */
export function hostedContractCompatible(version: unknown): boolean {
  return version === undefined ? HOSTED_CONTRACT_VERSION === 1 : version === HOSTED_CONTRACT_VERSION;
}
