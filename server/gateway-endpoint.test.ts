import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayEndpointPath, publishGatewayEndpoint, removeGatewayEndpoint } from "./gateway-endpoint.ts";

describe("capability gateway endpoint descriptor", () => {
  it("publishes owner-only loopback auth and removes only its own generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-gateway-endpoint-"));
    try {
      const path = publishGatewayEndpoint(dir, {
        url: "http://127.0.0.1:8799/api/internal/capabilities",
        authorization: "opaque-runtime-token",
        manifestSha256: "a".repeat(64),
        pid: 42,
      });
      const body = JSON.parse(readFileSync(path, "utf8"));
      expect(body).toMatchObject({ schema: "openmaus.capability-gateway-endpoint.v1", pid: 42 });
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      removeGatewayEndpoint(dir, 99);
      expect(readFileSync(gatewayEndpointPath(dir), "utf8")).toContain("opaque-runtime-token");
      removeGatewayEndpoint(dir, 42);
      expect(() => readFileSync(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
