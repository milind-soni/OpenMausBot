import { createHash } from "node:crypto";

import { createAgentGraphProfileManifest } from "./access-profile.ts";
import { isSecretName, redactSecrets } from "./redact.ts";

interface GraphAuthorityInput {
  sourceSha: string;
  release: string;
  instanceId: string;
  engine: string;
  providerVersion: string | null;
  cli: string | null;
  cliIdentity: string;
  providerConfig: unknown;
  environment: Record<string, string | undefined>;
  capabilities: Record<string, unknown>;
}

function sanitizedConfig(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[depth-bounded]";
  if (key && isSecretName(key)) return value === undefined || value === null || value === "" ? "[not-configured]" : "[configured]";
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizedConfig(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 256)
      .map(([childKey, item]) => [childKey, sanitizedConfig(item, childKey, depth + 1)]));
  }
  if (typeof value === "string") return String(redactSecrets(value)).slice(0, 2_000);
  return value;
}

function sanitizedEnvironment(environment: Record<string, string | undefined>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        isSecretName(name)
          ? value === undefined || value === "" ? "[not-configured]" : "[configured]"
          // Environment strings are authority inputs, not display fields.
          // Bind the complete redacted value: truncation or an entry-count
          // cap would let a late suffix/key drift without invalidating the
          // approved route digest.
          : value === undefined ? "[undefined]" : redactSecrets(value),
      ]),
  );
}

/**
 * Bind a preview route to the exact app/provider enforcement generation.
 * Credential values are deliberately absent: secret-shaped environment and
 * config entries bind only configured/not-configured markers. Non-secret
 * environment values are sanitized and bound so changing a provider base
 * URL, profile, or other process input invalidates an older draft without
 * turning the digest into a credential oracle.
 */
export function graphAuthorityDigest(input: GraphAuthorityInput): string {
  const payload = {
    schema: "openmaus.agent-graph-authority.v2",
    sourceSha: input.sourceSha,
    release: input.release,
    instanceId: input.instanceId,
    engine: input.engine,
    providerVersion: input.providerVersion ?? "unknown",
    cli: input.cli ?? "default",
    cliIdentity: input.cliIdentity,
    providerConfig: sanitizedConfig(input.providerConfig),
    environment: sanitizedEnvironment(input.environment),
    capabilities: sanitizedConfig(input.capabilities),
    brokerContract: {
      approvalBroker: "forced-provider-broker",
      desktopAuthority: "private-ipc-hmac-one-use",
      providerTools: "denied",
      gatewayServers: ["openmaus-host"],
      retrieval: "none",
      pathPolicy: "nofollow-single-link-exact-preimage-v1",
    },
    capabilityManifests: ["read", "workspace-write", "protected"].map((permissionClass) =>
      createAgentGraphProfileManifest(permissionClass as "read" | "workspace-write" | "protected").sha256),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
