import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import { createLimitTakeover } from "../../host/limit-takeover.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createOpenCodeDriver, openCodeLimitFacts, parseOpenCodeModelsOutput, resetOpenCodeModelCache } from "./opencode-go.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const REFUSED = "opencode/refused-free";
const OTHER = "opencode/other";
const MESSAGE = "FreeUsageLimitError: free models are limited today";
const dirs: string[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
  resetOpenCodeModelCache();
});

function prices(other: "free" | "paid" | "unknown"): ModelCatalog {
  return parseOpenCodeModelsOutput([
    REFUSED, JSON.stringify({ cost: { input: 0, output: 0 } }),
    OTHER, JSON.stringify(other === "unknown" ? {} : { cost: { input: other === "free" ? 0 : 1, output: 0 } }),
  ].join("\n"))!;
}

it.each(["paid", "unknown"] as const)("does not reuse an old free price when the current price is %s", (price) => {
  prices("free");
  const current = prices(price);
  expect(openCodeLimitFacts(MESSAGE, REFUSED, current)).toEqual({ limit: "model" });
});

it("keeps the current free-price facts independent of another catalog", () => {
  const first = prices("free");
  const second = prices("paid");
  expect(openCodeLimitFacts(MESSAGE, REFUSED, first)).toEqual({ limit: "model", limitModels: [REFUSED, OTHER] });
  expect(openCodeLimitFacts(MESSAGE, REFUSED, second)).toEqual({ limit: "model" });
  expect(openCodeLimitFacts(MESSAGE, REFUSED)).toEqual({ limit: "model" });
  expect(openCodeLimitFacts("GoUsageLimitError: usage limit reached", REFUSED, first)).toEqual({ limit: "engine" });
});

it.each(["free", "paid", "unknown", "failed"] as const)("applies only current confirmed free prices after a %s refresh through the ACP driver", async (price) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-opencode-prices-"));
  dirs.push(dir);
  const failure = join(dir, "failure.json");
  writeFileSync(failure, JSON.stringify({ code: "QUOTA_EXCEEDED", message: MESSAGE }));
  let current: "free" | typeof price = "free";
  const driver = createOpenCodeDriver(async () => {
    if (current === "failed") throw new Error("fixture discovery unavailable");
    return prices(current);
  });
  const instance = await driver.create({
    instanceId: `price-${price}`, displayName: "OpenCode", enabled: true,
    config: { cli: CLI, fullAuto: false, workspace: dir },
    environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, OPENCODE_API_KEY: "fixture-key",
      FAKE_ACP_MODELS: `${REFUSED},${OTHER}`, FAKE_ACP_RPC_FAILURE_FILE: failure },
  });
  instances.push(instance);
  await instance.startupModelRefresh;
  current = price;
  await instance.refreshModels?.();
  const recorder = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ threadId: `price-${price}`, text: "hello", model: REFUSED });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const error = recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId);
    expect(error).toMatchObject({ type: "runtime.error", limit: "model" });
    const takeover = createLimitTakeover({
      file: join(dir, "notices.json"), engines: () => [], configs: () => ({}), context: {},
      blockedUntil: () => null, chosen: () => [], engineName: (id) => id, tell: () => {}, record: () => {},
    });
    takeover.noteRuntimeEvent("fixture", { instanceId: instance.instanceId, model: REFUSED }, error!);
    expect(takeover.modelHeld({ instanceId: instance.instanceId, model: REFUSED })).not.toBeNull();
    const otherHold = takeover.modelHeld({ instanceId: instance.instanceId, model: OTHER });
    if (price === "free") expect(otherHold).not.toBeNull();
    else expect(otherHold).toBeNull();
  } finally {
    recorder.stop();
  }
});

it("uses each instance's own free prices when the instances share a driver", async () => {
  const driver = createOpenCodeDriver(async (environment) => prices(environment.FIXTURE_PRICE === "paid" ? "paid" : "free"));
  for (const price of ["free", "paid"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "omb-opencode-instance-prices-"));
    dirs.push(dir);
    const failure = join(dir, "failure.json");
    writeFileSync(failure, JSON.stringify({ code: "QUOTA_EXCEEDED", message: MESSAGE }));
    const instance = await driver.create({
      instanceId: `instance-${price}`, displayName: "OpenCode", enabled: true,
      config: { cli: CLI, fullAuto: false, workspace: dir },
      environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir,
        OPENCODE_API_KEY: "fixture-key", FIXTURE_PRICE: price, FAKE_ACP_MODELS: `${REFUSED},${OTHER}`, FAKE_ACP_RPC_FAILURE_FILE: failure },
    });
    instances.push(instance);
    await instance.startupModelRefresh;
  }
  for (const instance of instances) {
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: instance.instanceId, text: "hello", model: REFUSED });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const error = recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId);
      expect(error).toMatchObject({ limit: "model" });
      if (instance.instanceId === "instance-free") expect(error).toHaveProperty("limitModels", [REFUSED, OTHER]);
      else expect(error).not.toHaveProperty("limitModels");
    } finally {
      recorder.stop();
    }
  }
});
