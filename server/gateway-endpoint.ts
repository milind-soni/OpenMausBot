import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export interface CapabilityGatewayEndpoint {
  schema: "openmaus.capability-gateway-endpoint.v1";
  url: string;
  authorization: string;
  manifestSha256: string;
  pid: number;
  createdAt: string;
}
export function gatewayEndpointPath(dataDir: string): string {
  return join(dataDir, "runtime", "capability-gateway.json");
}

export function publishGatewayEndpoint(
  dataDir: string,
  input: Omit<CapabilityGatewayEndpoint, "schema" | "createdAt">,
): string {
  const path = gatewayEndpointPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify({
    schema: "openmaus.capability-gateway-endpoint.v1",
    createdAt: new Date().toISOString(),
    ...input,
  } satisfies CapabilityGatewayEndpoint, null, 2), { mode: 0o600 });
  return path;
}

export function removeGatewayEndpoint(dataDir: string, pid = process.pid): void {
  const path = gatewayEndpointPath(dataDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (parsed.pid !== pid) return;
    unlinkSync(path);
  } catch {
    // Missing, malformed, or replaced by a newer app instance: leave it.
  }
}
