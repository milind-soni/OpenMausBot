import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { gatewayConfig, writeGatewayConfig } from "../deploy/gateway/configure.mjs";
import { CodexDriver } from "../server/drivers/codex.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";

it("configures all three model providers through Codex with Gemini as default", () => {
  const config = gatewayConfig("synthetic-gateway-key");
  expect(config.defaultModelSelection).toEqual({ instanceId: "google", model: "gemini-3.8-flash" });
  expect(Object.keys(config.instances)).toEqual(["azure", "google", "bedrock"]);
  for (const instance of Object.values(config.instances)) {
    expect(instance.driver).toBe("codex");
    expect(CodexDriver.decodeConfig(instance.config).provider.url).toBe("http://127.0.0.1:4000/v1");
    expect(Object.keys(instance.environment)).toEqual(["OPENMAUS_MODEL_GATEWAY_KEY"]);
  }
  expect(() => gatewayConfig("")).toThrow("private value");
});

it("writes private fresh configuration and refuses to overwrite it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-gateway-config-"));
  const path = join(scratch, "home", "config.json");
  try {
    writeGatewayConfig(path, "synthetic-gateway-key");
    const first = readFileSync(path, "utf8");
    expect(() => writeGatewayConfig(path, "replacement-fixture-key")).toThrow();
    expect(readFileSync(path, "utf8")).toBe(first);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    await removeTempDir(scratch);
  }
});
