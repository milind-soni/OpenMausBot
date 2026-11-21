// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/acp/AntigravityAcpSupport.test.ts:62-99 (the
//     table of versions and the name each gets).
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { antigravityClientInfo, antigravityTokenPath, prepareAntigravityProfile, probeAntigravityModels } from "./antigravity-acp.ts";
import { resolveAntigravityRuntime } from "./antigravity-runtime.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const OWN = { name: "openmausbot", version: "0.0.0" };
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function fakeRuntime() {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-client-"));
  scratch.push(directory);
  const executable = join(directory, "fake-antigravity.ts");
  const harness = join(directory, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
  copyFileSync(FAKE_ACP, executable);
  copyFileSync(FAKE_ACP, harness);
  if (process.platform !== "win32") for (const file of [executable, harness]) chmodSync(file, 0o755);
  return { directory, executable, dump: join(directory, "dump.json") };
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("the client name an Antigravity runtime is started with", () => {
  it.each([
    { version: "1.4.1", ownName: false },
    { version: "1.4.2", ownName: false },
    { version: "1.4.3", ownName: false },
    { version: "1.4.5", ownName: false },
    { version: "1.4.6", ownName: false },
    { version: "1.5.0", ownName: false },
    { version: "1.5.1", ownName: true },
    { version: "1.5.7", ownName: true },
    { version: "1.10.0", ownName: true },
    { version: "2.0.0", ownName: true },
    { version: "1.3.0", ownName: false },
    { version: undefined, ownName: false },
    { version: null, ownName: false },
    { version: "unknown", ownName: false },
  ])("$version: own client name $ownName", ({ version, ownName }) => {
    expect(antigravityClientInfo(version)).toEqual(ownName ? OWN : { name: "zed", version: "0.0.0" });
  });

  it.each(["1.4.3", "1.5.1", undefined])("is the app's own for %s once the switch is off", (version) => {
    expect(antigravityClientInfo(version, false)).toEqual(OWN);
  });

  it("reaches the runtime's initialize for a turn and for the model lookup", async () => {
    ensureDirs();
    const turn = fakeRuntime();
    const instanceId = "antigravity-client-name";
    const token = antigravityTokenPath(instanceId);
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, "{}", { mode: 0o600 });
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true,
      config: { cli: turn.executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Google Antigravity", FAKE_ACP_DUMP: turn.dump },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "client-name", text: "hello", approvalMode: "full", cwd: turn.directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(JSON.parse(readFileSync(`${turn.dump}.initialize.json`, "utf8")).clientInfo).toEqual({ name: "zed", version: "0.0.0" });

    const lookup = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(lookup.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "lookup", runtime, baseDir: lookup.directory,
      baseEnv: { ...process.env, FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Google Antigravity", FAKE_ACP_DUMP: lookup.dump },
    });
    await probeAntigravityModels({ runtime: { ...runtime, version: "1.5.1" }, profile, fallbackDefault: "gemini-3.8-flash" });
    expect(JSON.parse(readFileSync(`${lookup.dump}.initialize.json`, "utf8")).clientInfo).toEqual(OWN);
  }, 90_000);
});
