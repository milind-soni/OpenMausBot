import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliProbeEnvironment } from "./cli-probe.ts";
import { withoutCloudSecrets } from "./cloud-secrets.ts";
import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV } from "./credential-env.ts";
import { holdIncludedServices } from "./included-services.ts";
import { probeEnvironment } from "./mcp-probe.ts";
import { createAcpDriver } from "./drivers/acp/core.ts";
import { createOpenCodeDriver, setOpenCodeProviderKeyPolicy } from "./drivers/acp/opencode-go.ts";
import { cloudHomeConfigured } from "./cloud-home.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import * as procs from "./procs.ts";
import { recordEvents } from "./testing/events.ts";

const spellings = (name: string) => [name, name.toLowerCase(), name[0] + name.slice(1).toLowerCase()];
const catalog = { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setOpenCodeProviderKeyPolicy(() => !cloudHomeConfigured() && !hostedWorkspaceConfigured());
});

describe("credential environment casing", () => {
  it.each(["Claude", "Codex"])("scrubs inherited credential aliases before launching %s", async (kind) => {
    const cli = fileURLToPath(new URL(kind === "Claude" ? "./testing/fake-claude-cli.ts" : "./testing/fake-codex-app-server.ts", import.meta.url));
    vi.stubEnv("anthropic_api_key", "synthetic-operator");
    vi.stubEnv("openai_api_key", "synthetic-operator");
    vi.stubEnv("Openmausbot_Chatgpt_Token", "synthetic-operator");
    const launches = vi.spyOn(procs, "spawnCli");
    const input = { instanceId: `case-${kind}`, displayName: "Fixture", enabled: true, environment: {} };
    const instance = kind === "Claude"
      ? await ClaudeDriver.create({ ...input, config: ClaudeDriver.decodeConfig({ cli }) })
      : await CodexDriver.create({ ...input, config: CodexDriver.decodeConfig({ cli }) });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: `case-${kind}`, text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");
      const environments = launches.mock.calls.filter((call) => call[3] === "bot").map((call) => call[2]?.env);
      expect(environments.length).toBeGreaterThan(0);
      for (const env of environments) {
        expect(env?.[kind === "Claude" ? "anthropic_api_key" : "openai_api_key"]).toBeUndefined();
        if (kind === "Codex") expect(env?.Openmausbot_Chatgpt_Token).toBeUndefined();
      }
    } finally { await instance.dispose(); }
  });

  it("keeps every spelling of workspace credentials out of a real child", () => {
    const credentials = Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.flatMap((name) => spellings(name).map((key) => [key, "synthetic-secret"])));
    const env = { ...credentials, OMB_CLOUDFLARED_PATH: "fixture-cloudflared", MY_FLAG: "fixture-flag" };
    stripWorkspaceCredentialEnv(env);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const names: string[] = JSON.parse(child.stdout);
    expect(names).toContain("MY_FLAG");
    expect(names).toContain("OMB_CLOUDFLARED_PATH");
    expect(names.filter((key) => Object.hasOwn(credentials, key))).toEqual([]);
    expect(env).toEqual({ OMB_CLOUDFLARED_PATH: "fixture-cloudflared", MY_FLAG: "fixture-flag" });
  });

  it.each(["CLI", "MCP"])("removes inherited provider key spellings from %s probes", (kind) => {
    const names = PROVIDER_CREDENTIAL_ENV.flatMap(spellings);
    for (const name of names) vi.stubEnv(name, "synthetic-inherited");
    const env = kind === "CLI" ? cliProbeEnvironment() : probeEnvironment({ env: {} });
    expect(names.filter((name) => env[name] !== undefined)).toEqual([]);
    expect(probeEnvironment({ env: { OPENAI_API_KEY: "synthetic-configured" } }).OPENAI_API_KEY).toBe("synthetic-configured");
  });

  it("applies ACP provider allow-lists without letting foreign credential spellings through", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const driver = createAcpDriver({
      driverKind: "credential-case-fixture", displayName: "Fixture", models: catalog,
      defaultCli: "unused-fixture-cli", nativeSource: "fixture.acp", loginNote: "fixture",
      spawnArgs: () => [], pickAuthMethod: () => null, credentialEnv: ["GEMINI_API_KEY"],
      authFailure: "continue", isAuthenticated: () => true,
      resolveModels: async (env) => { seen = env; return catalog; },
    });
    const instance = await driver.create({ instanceId: "credential-case-fixture", displayName: "Fixture", enabled: true,
      environment: { omb_openai_api_key: "workspace", Openai_Api_Key: "foreign", GEMINI_API_KEY: "own", MY_FLAG: "kept" }, config: driver.defaultConfig() });
    try {
      expect(seen).toMatchObject({ GEMINI_API_KEY: "own", MY_FLAG: "kept" });
      expect(seen.omb_openai_api_key).toBeUndefined();
      expect(seen.Openai_Api_Key).toBeUndefined();
    } finally { await instance.dispose(); }
  });

  it("withholds inherited OpenCode provider aliases even when an owner saved the canonical key", async () => {
    setOpenCodeProviderKeyPolicy(() => false);
    vi.stubEnv("anthropic_api_key", "synthetic-operator");
    vi.stubEnv("Openai_Api_Key", "synthetic-operator");
    let seen: NodeJS.ProcessEnv = {};
    const driver = createOpenCodeDriver(async (env) => { seen = env; return catalog; });
    const instance = await driver.create({ instanceId: "opencode-case-fixture", displayName: "Fixture", enabled: true,
      environment: { ANTHROPIC_API_KEY: "synthetic-owner" }, config: driver.defaultConfig() });
    try {
      expect(seen.ANTHROPIC_API_KEY).toBe("synthetic-owner");
      expect(seen.anthropic_api_key).toBeUndefined();
      expect(seen.Openai_Api_Key).toBeUndefined();
    } finally { await instance.dispose(); }
  });

  it("removes Cloud secret aliases from copied launcher environments", () => {
    const env = { omb_cloud_bootstrap_secret: "synthetic", Omb_Cloud_Boat_Token: "synthetic", MY_FLAG: "kept" };
    expect(withoutCloudSecrets(env)).toEqual({ MY_FLAG: "kept" });
    expect(env.omb_cloud_bootstrap_secret).toBe("synthetic");
  });

  it("removes included-service token aliases before later children can inherit them", () => {
    const env = { omb_cloud_boat_token: "synthetic", Omb_Cloud_Voice_Token: "synthetic", MY_FLAG: "kept" };
    holdIncludedServices(env);
    expect(env).toEqual({ MY_FLAG: "kept" });
  });
});
