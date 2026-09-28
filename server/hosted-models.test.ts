import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostedModelPolicy } from "./hosted-models.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { recordEvents } from "./testing/events.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [], registries: ProviderRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.disposeAll()));
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});
const directory = () => { const value = mkdtempSync(join(tmpdir(), "omb-hosted-models-")); directories.push(value); return value; };
const token = `omb_workspace_${"a".repeat(43)}`;
const env = () => ({ OMB_ADMIN_URL: "https://admin.example.test", OMB_PUBLIC_URL: "https://fixture.example.test", OMB_ADMIN_WORKSPACE: "fixture", OMB_ADMIN_MEMBERSHIP: "portal",
  OMB_HOSTED_MODEL_TOKEN: token, OMB_HOSTED_MODELS: JSON.stringify({ anthropic: ["claude-fixture"], openai: ["gpt-fixture"], openrouter: ["provider/fixture"] }) });

it("requires an explicit complete hosted policy and leaves normal desktops alone", () => {
  expect(hostedModelPolicy(directory(), {})).toBeNull();
  expect(hostedModelPolicy(directory(), { OMB_ADMIN_URL: "https://admin.example.test" })).toBeNull();
  for (const invalid of [ { ...env(), OMB_ADMIN_MEMBERSHIP: "local" }, { ...env(), OMB_HOSTED_MODEL_TOKEN: "secret" },
    { ...env(), OMB_ADMIN_URL: "http://admin.example.test" }, { ...env(), OMB_DESKTOP_PARENT: "1" },
    { ...env(), OMB_HOSTED_MODELS: "{}" } ]) expect(() => hostedModelPolicy(directory(), invalid)).toThrow();
});

it("preserves allowed choices, normalizes legacy routes, and replaces only unassigned choices", () => {
  const policy = hostedModelPolicy(directory(), env())!;
  expect(policy.select({ instanceId: "claude", model: "claude-fixture", effort: "high" })).toEqual({ instanceId: "claude", model: "claude-fixture", effort: "high" });
  expect(policy.select({ instanceId: "codex", model: "omb-managed-openai::gpt-fixture" })).toEqual({ instanceId: "codex", model: "gpt-fixture" });
  expect(policy.select({ instanceId: "opencode", model: "omb-managed-openrouter/provider/fixture" })).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.select({ instanceId: "codex", model: "removed-model" })).toEqual({ instanceId: "codex", model: "gpt-fixture" });
  expect(policy.select({ instanceId: "other", model: "personal" })).toEqual({ instanceId: "claude", model: "claude-fixture" });
  expect(policy.allows({ instanceId: "codex", model: "personal" })).toBe(false);
  expect(policy.allows({ instanceId: "other", model: "gpt-fixture" })).toBe(false);
  const empty = hostedModelPolicy(directory(), { ...env(), OMB_HOSTED_MODELS: JSON.stringify({ anthropic: [], openai: [], openrouter: [] }) })!;
  expect(empty.select({ instanceId: "codex", model: "personal" })).toEqual({ instanceId: "", model: "" });
  expect(empty.configs()).toEqual({});
  expect(empty.error()).toContain("No company models");
});

it.each([{ variant: "high" }, { effort: "high" as const }])("preserves an assigned raw OpenRouter model without unsupported OpenCode metadata: %j", metadata => {
  const policy = hostedModelPolicy(directory(), env())!;
  const previous = { instanceId: "opencode", model: "provider/fixture", ...metadata };
  const selection = policy.select(previous);
  expect(selection).toEqual({ instanceId: "opencode", model: "provider/fixture" });
  expect(policy.allows(selection)).toBe(true);
  expect(policy.select(selection)).toEqual(selection);
});

it("locks native and OpenRouter instances to assigned catalogs and fixed gateway routes", async () => {
  const root = directory(), policy = hostedModelPolicy(root, { ...env(),
    OMB_HOSTED_CLAUDE_CLI: join(import.meta.dirname, "testing/fake-claude-cli.ts"),
    OMB_HOSTED_CODEX_CLI: join(import.meta.dirname, "testing/fake-codex-app-server.ts"),
  })!;
  const configs = policy.configs();
  expect(Object.keys(configs)).toEqual(["claude", "codex", "opencode"]);
  expect(configs.claude.environment).toMatchObject({ ANTHROPIC_BASE_URL: "https://admin.example.test/api/gateway/fixture/anthropic", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-fixture" });
  expect(configs.codex.environment).toEqual({ OPENMAUSBOT_COMPANY_API_KEY: token, CODEX_HOME: join(root, "providers/hosted/codex") });
  expect(configs.codex.config).toMatchObject({ managed: { models: ["gpt-fixture"], url: "https://admin.example.test/api/gateway/fixture/openai/v1" } });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const registry = new ProviderRegistry([ClaudeDriver, CodexDriver, OpenAICompatDriver], { npmAvailable: () => false }); registries.push(registry);
  await registry.load(configs, instance => policy.decorate(instance));
  for (const [id, model] of [["claude", "claude-fixture"], ["codex", "gpt-fixture"], ["opencode", "provider/fixture"]]) {
    const instance = registry.get(id)!;
    expect(instance.models.options.map(row => row.id)).toEqual([model]);
    expect(instance.startAuthentication).toBeUndefined();
    await expect(instance.adapter.sendTurn({ threadId: "forbidden", text: "Synthetic", model: "unassigned" })).rejects.toThrow("not assigned");
    await instance.refreshModels?.();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses bundled executable names unless the operator explicitly overrides them", () => {
  const configs = hostedModelPolicy(directory(), env())!.configs();
  expect(configs.claude.config).toMatchObject({ cli: "claude" });
  expect(configs.codex.config).toMatchObject({ cli: "codex" });
  expect(Object.keys(configs)).toEqual(["claude", "codex", "opencode"]);
});

it("sends a hosted Claude turn and helper through the approved model with synthetic CLI only", async () => {
  const root = directory(), policy = hostedModelPolicy(root, { ...env(), OMB_HOSTED_CLAUDE_CLI: join(import.meta.dirname, "testing/fake-claude-cli.ts") })!;
  const configs = policy.configs();
  const dump = join(root, "claude-spawn.json");
  configs.claude.environment!.FAKE_CLAUDE_DUMP = dump;
  const registry = new ProviderRegistry([ClaudeDriver], { npmAvailable: () => false }); registries.push(registry);
  await registry.load({ claude: configs.claude }, instance => policy.decorate(instance));
  const claude = registry.get("claude")!, events = recordEvents(claude.adapter);
  await claude.adapter.sendTurn({ threadId: "hosted-fixture", text: "Synthetic turn", model: "claude-fixture", cwd: root });
  await events.until(event => event.type === "turn.completed"); events.stop();
  let spawned = JSON.parse(readFileSync(dump, "utf8"));
  expect(spawned.argv[spawned.argv.indexOf("--model") + 1]).toBe("claude-fixture");
  expect(spawned.env.ANTHROPIC_BASE_URL).toBe("https://admin.example.test/api/gateway/fixture/anthropic");
  await claude.generateText!("Synthetic title");
  spawned = JSON.parse(readFileSync(dump, "utf8"));
  expect(spawned.argv[spawned.argv.indexOf("--model") + 1]).toBe("claude-fixture");
});
