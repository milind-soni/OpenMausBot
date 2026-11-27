import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { createLimitTakeover } from "../../host/limit-takeover.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createOpenCodeDriver, parseOpenCodeModelsOutput, resetOpenCodeModelCache } from "./opencode-go.ts";

const CURRENT = "opencode/current-free";
const RETIRED = "opencode/retired-free";
const SHARED = "opencode/shared-free";
const PAID = "opencode/paid";

it.each([
  { saved: CURRENT, shared: false },
  { saved: RETIRED, shared: false },
  { saved: RETIRED, shared: true },
])("holds the acknowledged model when saved=$saved and shared=$shared", async ({ saved, shared }) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-opencode-ack-"));
  const failure = join(dir, "failure.json");
  writeFileSync(failure, JSON.stringify({ code: "QUOTA_EXCEEDED", message: "FreeUsageLimitError: free models are limited today" }));
  const catalog = parseOpenCodeModelsOutput([
    CURRENT, JSON.stringify({ cost: { input: 0, output: 0 } }),
    ...(shared ? [SHARED, JSON.stringify({ cost: { input: 0, output: 0 } })] : []),
    PAID, JSON.stringify({ cost: { input: 1, output: 1 } }),
  ].join("\n"))!;
  const instance = await createOpenCodeDriver(async () => catalog).create({
    instanceId: "opencode-ack", displayName: "OpenCode", enabled: true,
    config: { cli: join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts"), fullAuto: false, workspace: dir },
    environment: {
      HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, OPENCODE_API_KEY: "fixture-key",
      FAKE_ACP_MODELS: [CURRENT, ...(shared ? [SHARED] : []), PAID].join(","), FAKE_ACP_RPC_FAILURE_FILE: failure,
    },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.startupModelRefresh;
    const { turnId } = await instance.adapter.sendTurn({ threadId: "ack-thread", text: "hello", model: saved });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ model: CURRENT, turnId });
    const takeover = createLimitTakeover({
      file: join(dir, "notices.json"), engines: () => [], configs: () => ({}), context: {},
      blockedUntil: () => null, chosen: () => [], engineName: (id) => id, tell: () => {}, record: () => {},
    });
    for (const event of recorder.events) takeover.noteRuntimeEvent("fixture", { instanceId: instance.instanceId, model: saved }, event);
    const held = (model: string) => takeover.modelHeld({ instanceId: instance.instanceId, model });
    expect(held(CURRENT), "the fallback that actually reached the allowance is held").not.toBeNull();
    expect(held(RETIRED), "an unavailable saved model did not consume this allowance").toBeNull();
    expect(held(PAID), "paid models do not share the refused free allowance").toBeNull();
    if (shared) expect(held(SHARED)).not.toBeNull();
  } finally {
    recorder.stop();
    await instance.dispose();
    resetOpenCodeModelCache();
    await removeTempDir(dir);
  }
});
