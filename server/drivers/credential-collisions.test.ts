import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { credentialEnvEntries, credentialEnvValue, stripCredentialEnv } from "../credential-env.ts";
import { augmentedPath } from "../env-path.ts";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { createAcpDriver } from "./acp/core.ts";
import { AcpHost } from "./acp/host.ts";
import { copilotSignedIn } from "./acp/copilot.ts";
import { hasDeepSeekKey } from "./acp/deepseek.ts";
import { geminiIsAuthenticated } from "./acp/gemini.ts";
import { claudeBilling } from "./claude-billing.ts";

const cli = fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url));
afterEach(() => { vi.restoreAllMocks(); });

for (const aliasFirst of [false, true]) {
  it.each([
    ["Gemini", "GEMINI_API_KEY", geminiIsAuthenticated],
    ["DeepSeek", "DEEPSEEK_API_KEY", hasDeepSeekKey],
  ] as const)(`%s accepts a canonical key beside a whitespace alias (alias first: ${aliasFirst})`, (_provider, name, ready) => {
    const entries = [[name.toLowerCase(), " "], [name, "synthetic-key"]];
    const keys = Object.fromEntries(aliasFirst ? entries : entries.toReversed());
    expect(ready({ HOME: homedir(), DSH_HOME: homedir(), ...keys })).toBe(true);
  });

  it.each(["GH_TOKEN", "Gh_Token", "gh_token"])(`Copilot re-probes after %s rotates beside other spellings (alias first: ${aliasFirst})`, async (rotated) => {
    const entries = [["gh_token", "synthetic-lower"], ["Gh_Token", "synthetic-mixed"], ["GH_TOKEN", "synthetic-canonical"]];
    const home = join(homedir(), `copilot-${aliasFirst}-${rotated}`);
    const env: NodeJS.ProcessEnv = {
      PATH: augmentedPath(), HOME: home, USERPROFILE: home, COPILOT_HOME: home,
      ...Object.fromEntries(aliasFirst ? entries : entries.toReversed()), FAKE_ACP_MODE: "auth-required",
    };
    const spawned = vi.spyOn(procs, "spawnCli");
    expect(await copilotSignedIn(env, { cli }, 10_000)).toBe(false);
    const before = spawned.mock.calls.length;
    env[rotated] = "synthetic-new-token";
    env.FAKE_ACP_MODE = "happy";
    if (process.platform !== "win32") {
      const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env[process.argv[1]])", rotated], { env, encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe("synthetic-new-token");
    }
    expect(await copilotSignedIn(env, { cli }, 10_000)).toBe(true);
    expect(spawned.mock.calls.length).toBeGreaterThan(before);
  });
}

it.each(["", " ", undefined])("canonical spelling wins even with value %j", (value) => {
  const env = { anthropic_api_key: "synthetic-alias", ANTHROPIC_API_KEY: value };
  expect(credentialEnvValue(env, "ANTHROPIC_API_KEY")).toBe(value);
  expect(claudeBilling(env, { method: "login" }).billing).toBe(value ? "metered" : "subscription");
});

it("uses code-unit key order for aliases and keeps all original entries for restoration and scrubbing", () => {
  const entries: [string, string][] = [["openai_api_key", "lower"], ["Openai_Api_Key", "mixed"], ["oPENAI_API_KEY", "other"]];
  for (const ordered of [entries, entries.toReversed()]) {
    const env = Object.fromEntries(ordered);
    expect(credentialEnvValue(env, "OPENAI_API_KEY")).toBe("mixed");
    expect(credentialEnvEntries(env, ["OPENAI_API_KEY"])).toEqual([
      ["Openai_Api_Key", "mixed"], ["oPENAI_API_KEY", "other"], ["openai_api_key", "lower"],
    ]);
    const restored = Object.fromEntries(credentialEnvEntries(env, ["OPENAI_API_KEY"]));
    expect(restored).toEqual(env);
    expect(credentialEnvValue({ ...restored, OPENAI_API_KEY: "canonical" }, "OPENAI_API_KEY")).toBe("canonical");
    stripCredentialEnv(restored, ["OPENAI_API_KEY"]);
    expect(restored).toEqual({});
  }
});

it("retains the pre-upgrade fingerprint and shared process for one canonical OPENAI_API_KEY", async () => {
  const links = vi.spyOn(AcpHost.prototype, "link");
  const spawned = vi.spyOn(procs, "spawnCli");
  const driver = createAcpDriver({
    driverKind: "canonical-fingerprint", displayName: "Fixture", defaultCli: cli,
    models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
    nativeSource: "fixture.acp", loginNote: "fixture", spawnArgs: () => [], shareProcess: true,
    pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
    credentialEnv: ["OPENAI_API_KEY"],
    resolveCommand: async (env) => ({ command: process.execPath, args: [cli], env: Object.fromEntries(credentialEnvEntries(env, ["OPENAI_API_KEY"])) }),
  });
  const instance = await driver.create({
    instanceId: "canonical-fingerprint", displayName: "Fixture", enabled: true,
    environment: { OPENAI_API_KEY: "synthetic-key" }, config: driver.defaultConfig(),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    for (const threadId of ["canonical-a", "canonical-b"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hello" });
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId), JSON.stringify(recorder.events)).toMatchObject({ ok: true });
    }
    expect(spawned.mock.calls.filter(call => call[3] === "bot")).toHaveLength(1);
    expect(links.mock.contexts).toHaveLength(2);
    for (const host of links.mock.contexts as AcpHost[]) {
      expect(JSON.parse(host.key!)[4]).toBe("e3866c858fcee7c0");
    }
  } finally { recorder.stop(); await instance.dispose(); }
});
