import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeAccountInfo, claudeSignInCommand, createClaudeAccountSchema, newClaudeAccount } from "./claude-accounts.ts";
import { CLAUDE_ACCOUNT_ENV_KEYS } from "./drivers/claude.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { EventBus } from "./harness/bus.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import type { RuntimeEvent } from "./contracts.ts";

afterEach(() => vi.unstubAllEnvs());

describe("named Claude accounts", () => {
  it("creates independent ids/directories without duplicating credentials or losing the default fleet", () => {
    const cfg = { instances: { claude: { driver: "claudeAgent", environment: { ANTHROPIC_AUTH_TOKEN: "fixture-secret" }, config: { cli: "claude-wrapper" } }, ghost: { driver: "future" } } };
    const first = newClaudeAccount(cfg, { displayName: "Work" });
    const second = newClaudeAccount({ instances: first.instances }, { displayName: "Personal" });
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(second.instances[first.instanceId]).toEqual(first.instances[first.instanceId]);
    expect(first.instances[first.instanceId].environment).toBeUndefined();
    expect(first.instances[first.instanceId].config).toMatchObject({ cli: "claude-wrapper" });
    expect(first.instances.ghost).toMatchObject({ driver: "future" });
    expect(newClaudeAccount({}, { displayName: "Work" }).instances.codex).toBeDefined();
    expect(() => newClaudeAccount({ instances: first.instances }, { displayName: "Duplicate", configDir: (first.instances[first.instanceId].config as { configDir: string }).configDir })).toThrow(/already configured/);
    expect(() => newClaudeAccount(cfg, { displayName: "Invalid", configDir: "relative/path" })).toThrow(/absolute/);
    expect(createClaudeAccountSchema.safeParse({ displayName: " ", environment: { SECRET: "no" } }).success).toBe(false);
  });

  it("leaves the default CLI keychain namespace unset and quotes PowerShell values", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    const normal = claudeAccountInfo("claude", { driver: "claudeAgent" }, "claude");
    expect(normal.configDir).toBe("");
    expect(normal.signInCommand).not.toContain("export CLAUDE_CONFIG_DIR=");
    expect(() => claudeAccountInfo("broken", { driver: "claudeAgent", config: { configDir: 42 } }, "claude")).toThrow(/absolute/);
    const win = claudeSignInCommand("claude", "C:\\Users\\O'Neil\\Work $ account", "win32");
    expect(win).toContain("C:\\Users\\O''Neil\\Work $ account");
    expect(win).toContain("finally");
    expect(win).toContain("'auth' 'login'");
  });

  it.skipIf(process.platform === "win32")("executes POSIX sign-in instructions with exact arguments, no credential inheritance or shell expansion", () => {
    const directory = join(process.cwd(), "account with ' quotes $(echo WRONG) $HOME");
    const script = "console.log(JSON.stringify({argv:process.argv.slice(1),dir:process.env.CLAUDE_CONFIG_DIR,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,home:process.env.HOME}))";
    const cli = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const output = execFileSync("/bin/sh", ["-c", claudeSignInCommand(cli, directory)], { encoding: "utf8", env: { ...process.env, ...Object.fromEntries(CLAUDE_ACCOUNT_ENV_KEYS.map(key => [key, "fixture-secret"])) } });
    expect(JSON.parse(output)).toEqual({ argv: ["auth", "login"], dir: directory, home: process.env.HOME });
  });

  it("replaces one instance and its event subscription without disposing or duplicating siblings", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    const bus = new EventBus(() => {});
    const events: RuntimeEvent[] = [];
    bus.subscribe(event => events.push(event));
    await registry.load({ work: { driver: "fake", config: { cli: "old-cli" } }, personal: { driver: "fake" } });
    bus.attach(registry.instances());
    const personal = registry.get("personal");
    const before = fake.created.get("work")!;
    bus.detach("work");
    await registry.load({ work: { driver: "fake", displayName: "Renamed" } });
    bus.attach([registry.get("work")!]);
    const event = { eventId: "fixture", provider: "fake", threadId: "fixture", createdAt: new Date().toISOString(), type: "turn.started" } as const;
    before.emit(event);
    fake.created.get("personal")!.emit(event);
    fake.created.get("work")!.emit(event);
    expect(registry.get("personal")).toBe(personal);
    expect(fake.disposed).toEqual(["work"]);
    expect(registry.cliTarget("work")?.cli).toBeNull();
    expect(events.map(event => event.providerInstanceId)).toEqual(["personal", "work"]);
    bus.detachAll();
    await registry.disposeAll();
  });
});
