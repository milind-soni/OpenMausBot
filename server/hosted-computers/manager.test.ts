import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedComputerManager } from "./manager.ts";
import { createComputerProvider } from "./providers.ts";
import { hostedComputersStatus } from "../../shared/hosted-computers.ts";
import { startFakeHostedComputers, hostedFixtureConfig, HOSTED_PNG } from "../testing/fake-hosted-computers.ts";

afterEach(() => vi.unstubAllEnvs());

it.each(["orgo", "daytona"] as const)("%s: scoped machines survive sleep and server restart using the real adapter", async provider => {
  const fixture = await startFakeHostedComputers();
  const dir = mkdtempSync(join(tmpdir(), "nation-hosted-test-"));
  vi.stubEnv(`NATION_TEST_${provider.toUpperCase()}_API`, fixture.url);
  const manager = () => new HostedComputerManager(dir, "workspace-a", () => hostedFixtureConfig);
  try {
    await (await createComputerProvider(provider, hostedFixtureConfig)).check();
    const first = manager();
    expect(await first.status(provider, "alice-bot")).toEqual({ configured: true, state: null });
    expect(await first.start(provider, "alice-bot", false)).toBeNull();
    expect(fixture.machines).toHaveLength(0); // Auto/read-only checks never create or charge.
    await first.start(provider, "alice-bot", true);
    expect(fixture.machines).toHaveLength(1);
    await first.execute(provider, "alice-bot", "printf %s ALICE_SECRET > note.txt");
    expect(await first.screenshot(provider, "alice-bot")).toEqual({ png: HOSTED_PNG, format: "png" });
    await first.stop(provider, "alice-bot");
    expect(await first.start(provider, "alice-bot", false)).toBeNull();
    const restarted = manager();
    await restarted.start(provider, "alice-bot", true);
    expect(await restarted.execute(provider, "alice-bot", "cat note.txt")).toMatchObject({ exitCode: 0, stdout: "ALICE_SECRET" });
    expect(await restarted.execute(provider, "alice-bot", "false")).toMatchObject({ exitCode: 1 });
    await restarted.start(provider, "bob-bot", true);
    expect(await restarted.execute(provider, "bob-bot", "cat note.txt")).toMatchObject({ exitCode: 1 });
    // Same bot id in another workspace must resolve to another computer.
    await new HostedComputerManager(join(dir, "other"), "workspace-b", () => hostedFixtureConfig).start(provider, "alice-bot", true);
    expect(fixture.machines).toHaveLength(3);
    expect(new Set(fixture.machines.map(m => m.name)).size).toBe(3);
    expect(fixture.unknown).toEqual([]);
    if (provider === "daytona") expect(fixture.calls.find(c => c.method === "POST" && c.path === "/sandbox")!.body)
      .toMatchObject({ public: false, autoStopInterval: 30, autoDeleteInterval: -1, snapshot: "desktop-fixture", env: {} });
    // Missing/renamed provider resources never cause disk replacement.
    fixture.machines[0]!.name = "someone-elses-computer";
    await expect(restarted.start(provider, "alice-bot", true)).rejects.toThrow();
    expect(fixture.machines).toHaveLength(3);
    fixture.fail(true);
    const error = await restarted.start(provider, "bob-bot", true).catch(e => e);
    expect(error.message).not.toMatch(/fixture-secret/);
    expect(error.message).toContain("unavailable");
  } finally { await fixture.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("reconciles an uncertain create by stable name, serializes mutations and rechecks turn authority after lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nation-hosted-recovery-"));
  let machine: { id: string; name: string; state: string } | null = null;
  let finishGet: (() => void) | undefined;
  const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const create = vi.fn(async (name: string) => { machine = { id: "one-id", name, state: "running" }; throw new Error("lost response, secret-key"); });
  const client = { check: async () => {}, find: async () => machine,
    get: async () => { if (finishGet) await new Promise<void>(resolve => { finishGet = resolve; }); return machine!; },
    create, start: async () => machine!, stop: async () => {}, screenshot: async () => ({ png: HOSTED_PNG, format: "png" as const }), execute };
  const manager = () => new HostedComputerManager(dir, "workspace", () => hostedFixtureConfig, async () => client);
  try {
    await expect(manager().start("orgo", "bot", true)).rejects.toThrow("unavailable");
    const restarted = manager();
    await restarted.start("orgo", "bot", true);
    expect(create).toHaveBeenCalledTimes(1);
    let authorized = true;
    finishGet = () => {};
    const pending = restarted.execute("orgo", "bot", "echo secret", () => authorized);
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(restarted.stop("orgo", "bot")).rejects.toMatchObject({ status: 409 });
    authorized = false; finishGet!();
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(hostedComputersStatus(hostedFixtureConfig))).not.toContain("fixture-secret");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
