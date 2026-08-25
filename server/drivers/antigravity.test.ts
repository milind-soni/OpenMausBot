// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  AntigravityDriver,
  antigravityComputerMcpServer,
  ensureAntigravityComputerMcp,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

describe("readAntigravityModelCatalog", () => {
  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "omb-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary and fullAuto on", () => {
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: true });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: true });
  });
  it("fullAuto defaults to true, only false when explicitly set", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(true);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.12");
    // agy auth is keyring-backed with no reliable file marker, so the snapshot
    // must NOT claim signed-in from a mere directory — authenticated stays unset.
    expect((snap as any).authenticated).toBeUndefined();
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Antigravity computer MCP config", () => {
  const configPath = (home: string) => join(home, ".gemini", "config", "mcp_config.json");
  const readConfig = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8"));
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityComputerMcpServer(boxIntegrations)!;

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityComputerMcpServer(boxIntegrations)).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "bx_1",
        OGB_BOX_TOKEN: "box-tok",
        OMB_CONTROL_URL: "http://127.0.0.1:9/control",
        OMB_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityComputerMcpServer({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } });
    expect(antigravityComputerMcpServer({})).toBeNull();
    expect(antigravityComputerMcpServer(undefined)).toBeNull();
  });

  it("upserts only its own key — the user's servers and unknown top-level keys survive", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpcfg-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
          futureTopLevelKey: { keep: true },
        }),
      );
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      // A later turn on a different computer overwrites the key in place.
      ensureAntigravityComputerMcp(
        { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts fresh from malformed JSON instead of failing the turn", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpbad-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(configPath(home), "{{{ not json");
      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restricts the token-bearing config directory and file to the current user", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpperms-"));
    try {
      const directory = dirname(configPath(home));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      writeFileSync(configPath(home), "{}\n", { mode: 0o644 });

      ensureAntigravityComputerMcp(boxEntry(), { HOME: home });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its own MCP entry", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalEntry = { command: "user-owned-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalEntry } }),
      );
      const restoreExistingEntry = ensureAntigravityComputerMcp(boxEntry(), { HOME: home });
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntry();
      restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(originalEntry);
      expect(restored.mcpServers["another-helper"]).toEqual({ command: "another-mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a computer-less turn removes only its own key, and never creates the file just to remove", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcprm-"));
    try {
      // No file at all: removal is a no-op, not an empty file in the user's home.
      ensureAntigravityComputerMcp(null, { HOME: home });
      expect(existsSync(configPath(home))).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          },
        }),
      );
      ensureAntigravityComputerMcp(null, { HOME: home });
      const config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computerMcp only on full-auto instances, and never localComputerMcp", async () => {
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      // accept-edits print mode auto-denies tools that would prompt, so a
      // mount there could never fire — the capability must not be offered.
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(false);
      // The host desktop needs per-action human approval; print mode has no
      // approval channel in any mode.
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBeUndefined();
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBeUndefined();
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("uses the spawned CLI's HOME and restores the prior config when the turn exits", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpturn-"));
    const dump = join(home, "mcp-at-spawn.json");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-turn",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "100", FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "click things",
        integrations: boxIntegrations,
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes overlapping turns so each child sees only its own computer mount", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcplease-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-first",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "150", FAKE_AGY_MCP_DUMP: firstDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-second",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-first", text: "first", integrations: boxIntegrations });
      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-second", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSpawned).toBe(false);
      await firstRecorder.until((event) => event.type === "turn.completed");
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a child that hangs after result, restores the mount, and unblocks the next turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpreaper-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-zombie",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_MCP_DUMP: firstDump,
        FAKE_AGY_POST_RESULT_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-zombie",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-zombie", text: "first", integrations: boxIntegrations });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-zombie", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-reaps an interrupted child that ignores SIGTERM before result", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpinterrupt-"));
    const readyFile = join(home, "ready");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-interrupted",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_READY_FILE: readyFile,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-interrupt",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-interrupted", text: "first", integrations: boxIntegrations });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await first.adapter.interruptTurn("t-mcp-interrupted");

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-interrupt", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
