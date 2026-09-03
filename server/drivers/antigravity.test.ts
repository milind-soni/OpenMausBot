// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANTIGRAVITY_NETWORK_ROUTE_ENV, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_AGENTS_MCP_KEY,
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  AntigravityDriver,
  antigravityAgentsMcpServer,
  antigravityComputerMcpServer,
  antigravityMcpServers,
  antigravityProxyUnavailableReason,
  supportsAntigravityStreamInput,
  ensureAntigravityMcpServers,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

async function loopbackServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Antigravity stream input compatibility", () => {
  it("requires the release that introduced stream-JSON stdin", () => {
    expect(supportsAntigravityStreamInput("1.1.14")).toBe(false);
    expect(supportsAntigravityStreamInput("1.1.15")).toBe(true);
    expect(supportsAntigravityStreamInput("1.2.0-beta.1")).toBe(true);
    expect(supportsAntigravityStreamInput("not-semver")).toBe(false);
  });
});

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
    delete process.env.FAKE_AGY_DUMP;
    delete process.env.FAKE_AGY_VERSION;
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

  it("sends a Windows-sized room prompt over stdin instead of argv", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-long-prompt-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    await create();
    const system = `room instructions\n${"context-0123456789".repeat(8_000)}`;
    try {
      await instance.adapter.sendTurn({
        threadId: "t-long-prompt",
        text: "review the video",
        system,
        model: "gemini-3.1-pro-high",
      });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.prompt).toBe(`${system}\n\nreview the video`);
      expect(seen.argv).toContain("--input-format");
      expect(seen.argv).not.toContain("--print");
      expect(JSON.stringify(seen.argv)).not.toContain("room instructions");
      expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("explains how to update an agy version that cannot receive prompts safely", async () => {
    process.env.FAKE_AGY_VERSION = "1.1.14";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-old-agy", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.error",
        message: expect.stringMatching(/1\.1\.15\+.*agy update/),
      }),
      expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "unsupported_cli" }),
    ]));
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
    expect(snap.version).toBe("1.1.22");
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

  it("marks pre-stream-input versions unavailable with an update action", async () => {
    process.env.FAKE_AGY_VERSION = "1.1.14";
    const instance = await AntigravityDriver.create({
      instanceId: "agy-old",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await expect(instance.snapshot()).resolves.toMatchObject({
        state: "unavailable",
        version: "1.1.14",
        reason: expect.stringMatching(/1\.1\.15\+.*agy update/),
      });
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_VERSION;
    }
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

  it("applies Off, TUN, and Proxy to every Antigravity child environment", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-route-"));
    const { server, port } = await loopbackServer();
    const inherited = {
      HTTP_PROXY: "http://inherited-http",
      http_proxy: "http://inherited-http",
      HTTPS_PROXY: "http://inherited-https",
      https_proxy: "http://inherited-https",
      ALL_PROXY: "http://inherited-all",
      all_proxy: "http://inherited-all",
      NO_PROXY: "inherited-no-proxy",
      no_proxy: "inherited-no-proxy",
      GODEBUG: "custom=1,http2client=1,other=2",
    };
    const cases = [
      { route: "off", expectedRoute: "off", expected: inherited },
      {
        route: "system",
        expectedRoute: "tun",
        expected: { GODEBUG: "custom=1,other=2" },
      },
      {
        route: `proxy|HTTP://127.0.0.1:${port}`,
        expectedRoute: `proxy|http://127.0.0.1:${port}`,
        expected: {
          HTTP_PROXY: `http://127.0.0.1:${port}`,
          http_proxy: `http://127.0.0.1:${port}`,
          HTTPS_PROXY: `http://127.0.0.1:${port}`,
          https_proxy: `http://127.0.0.1:${port}`,
          ALL_PROXY: `http://127.0.0.1:${port}`,
          all_proxy: `http://127.0.0.1:${port}`,
          NO_PROXY: "127.0.0.1,localhost,[::1]",
          no_proxy: "127.0.0.1,localhost,[::1]",
          GODEBUG: "custom=1,other=2,http2client=0",
        },
      },
    ] as const;
    try {
      for (const [index, testCase] of cases.entries()) {
        const dumps = [join(scratch, `${index}-a.json`), join(scratch, `${index}-b.json`)];
        const instances = await Promise.all(dumps.map((dump, childIndex) => AntigravityDriver.create({
          instanceId: `agy-route-${index}-${childIndex}`,
          displayName: undefined,
          environment: {
            ...inherited,
            [ANTIGRAVITY_NETWORK_ROUTE_ENV]: testCase.route,
            FAKE_AGY_DUMP: dump,
          },
          enabled: true,
          config: { cli: FAKE_CLI, fullAuto: false },
        })));
        const recorders = instances.map((instance) => recordEvents(instance.adapter));
        await Promise.all(instances.map((instance, childIndex) =>
          instance.adapter.sendTurn({ threadId: `agy-route-thread-${index}-${childIndex}`, text: "route probe" }),
        ));
        await Promise.all(recorders.map((recorder) => recorder.until((event) => event.type === "turn.completed")));
        for (const dump of dumps) {
          const invocation = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
          expect(invocation.env[ANTIGRAVITY_NETWORK_ROUTE_ENV]).toBe(testCase.expectedRoute);
          for (const [name, value] of Object.entries(testCase.expected)) {
            expect(invocation.env[name] ?? invocation.env[name.toUpperCase()]).toBe(value);
          }
          if (testCase.expectedRoute === "tun") {
            for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
              expect(invocation.env[name] ?? invocation.env[name.toLowerCase()]).toBeUndefined();
            }
          }
        }
        await Promise.all(instances.map((instance) => instance.dispose()));
      }
    } finally {
      await closeServer(server);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("checks a Proxy endpoint before probe/turn spawn and reports a drop before result", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-dead-proxy-"));
    const dump = join(scratch, "spawn.json");
    const unused = await loopbackServer();
    const deadPort = unused.port;
    await closeServer(unused.server);
    const deadRoute = `proxy|http://127.0.0.1:${deadPort}`;
    const dead = await AntigravityDriver.create({
      instanceId: "agy-dead-proxy",
      displayName: undefined,
      environment: { [ANTIGRAVITY_NETWORK_ROUTE_ENV]: deadRoute, FAKE_AGY_DUMP: dump },
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const deadRecorder = recordEvents(dead.adapter);
    try {
      const expected = `Proxy unavailable: nothing is listening on 127.0.0.1:${deadPort}. Start the proxy or choose TUN/Off.`;
      expect(await dead.snapshot()).toMatchObject({ state: "unavailable", reason: expected });
      await dead.adapter.sendTurn({ threadId: "agy-dead-proxy-turn", text: "must not spawn" });
      await deadRecorder.until((event) => event.type === "turn.completed");
      expect(deadRecorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expected });
      expect(deadRecorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "proxy_unavailable" });
      expect(existsSync(dump)).toBe(false);
    } finally {
      await dead.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }

    const dropped = await loopbackServer();
    const droppedRoute = `proxy|http://127.0.0.1:${dropped.port}`;
    const dropScratch = mkdtempSync(join(tmpdir(), "omb-agy-mid-turn-drop-"));
    const ready = join(dropScratch, "mid-turn-ready");
    const dropInstance = await AntigravityDriver.create({
      instanceId: "agy-mid-turn-drop",
      displayName: undefined,
      environment: {
        [ANTIGRAVITY_NETWORK_ROUTE_ENV]: droppedRoute,
        FAKE_AGY_DELAY_MS: "1000",
        FAKE_AGY_READY_FILE: ready,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const dropRecorder = recordEvents(dropInstance.adapter);
    try {
      await dropInstance.adapter.sendTurn({ threadId: "agy-mid-turn-drop-thread", text: "proxy drops" });
      await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
      await closeServer(dropped.server);
      await dropInstance.adapter.interruptTurn("agy-mid-turn-drop-thread");
      await dropRecorder.until((event) => event.type === "turn.completed");
      const expected = `Proxy unavailable: nothing is listening on 127.0.0.1:${dropped.port}. Start the proxy or choose TUN/Off.`;
      expect(dropRecorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expected });
      expect(dropRecorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "proxy_unavailable" });
      expect(dropRecorder.events.some((event) => event.type === "runtime.error" && String((event as any).message).includes("agy exited"))).toBe(false);
    } finally {
      await dropInstance.dispose();
      await closeServer(dropped.server);
      rmSync(dropScratch, { recursive: true, force: true });
    }
  });

  it("reports protocol default ports for explicit loopback proxy URLs", async () => {
    const ports: number[] = [];
    const unavailable = (route: string) => antigravityProxyUnavailableReason(route, ({ port }) => {
      ports.push(port);
      const socket = new Socket();
      queueMicrotask(() => socket.emit("error", new Error("simulated unavailable proxy")));
      return socket;
    });
    await expect(unavailable("proxy|http://127.0.0.1:80"))
      .resolves.toBe("Proxy unavailable: nothing is listening on 127.0.0.1:80. Start the proxy or choose TUN/Off.");
    await expect(unavailable("proxy|https://127.0.0.1:443"))
      .resolves.toBe("Proxy unavailable: nothing is listening on 127.0.0.1:443. Start the proxy or choose TUN/Off.");
    expect(ports).toEqual([80, 443]);
  });

  it("keeps long generateText prompts off argv too", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-long-helper-"));
    const dump = join(scratch, "dump.json");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-long-helper",
      displayName: undefined,
      environment: { FAKE_AGY_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const prompt = `summarize\n${"helper-context-0123456789".repeat(6_000)}`;
    try {
      await expect(instance.generateText?.(prompt)).resolves.toBe("done from fake agy");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.prompt).toBe(prompt);
      expect(seen.argv).toContain("--input-format");
      expect(JSON.stringify(seen.argv)).not.toContain("helper-context");
      expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });
});

describe("Antigravity OpenMaus MCP config", () => {
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
  const agentsIntegrations = (token = "agents-tok") => ({
    agents: {
      command: process.execPath,
      args: [SPAWNED_PROXIES.agents],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OMB_HARNESS_URL: "http://127.0.0.1:8799",
        OMB_COMMS_TOKEN: token,
        OMB_BOT_ID: "gemini-bot",
        OMB_THREAD_ID: "thread-1",
        OMB_TURN_DEPTH: "0",
      },
    },
  });
  const agentsEntry = (token = "agents-tok") => ({
    command: process.execPath,
    args: [SPAWNED_PROXIES.agents],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      OMB_HARNESS_URL: "http://127.0.0.1:8799",
      OMB_COMMS_TOKEN: token,
      OMB_BOT_ID: "gemini-bot",
      OMB_THREAD_ID: "thread-1",
      OMB_TURN_DEPTH: "0",
    },
  });

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

  it("builds the teammate proxy spec and combines it atomically with the computer mount", () => {
    const integrations = { ...boxIntegrations, ...agentsIntegrations("turn-secret") };
    expect(antigravityAgentsMcpServer(integrations)).toEqual(agentsEntry("turn-secret"));
    expect(antigravityMcpServers(integrations)).toEqual({
      [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
      [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("turn-secret"),
    });
    expect(antigravityMcpServers(undefined)).toEqual({});
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

  it("upserts only its reserved keys — the user's servers and unknown top-level keys survive", () => {
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
      ensureAntigravityMcpServers(
        {
          [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry(),
        },
        { HOME: home },
      );
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(config.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry());

      // A later turn overwrites its present key and removes its absent key.
      ensureAntigravityMcpServers(
        {
          [ANTIGRAVITY_COMPUTER_MCP_KEY]: {
            command: "/opt/cua",
            args: ["--mcp"],
            env: { CUA_SOCKET: "/tmp/cua.sock" },
          },
        },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
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
      ensureAntigravityMcpServers(
        {
          [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry(),
        },
        { HOME: home },
      );
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(readConfig(home).mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry());
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

      ensureAntigravityMcpServers(
        { [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("permission-secret") },
        { HOME: home },
      );

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its reserved MCP entries", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityMcpServers(
        {
          [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("new-file-secret"),
        },
        { HOME: home },
      );
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalComputerEntry = { command: "user-owned-computer-mcp", args: ["--serve"] };
      const originalAgentsEntry = { command: "user-owned-agents-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalComputerEntry,
            [ANTIGRAVITY_AGENTS_MCP_KEY]: originalAgentsEntry,
          },
        }),
      );
      const restoreExistingEntries = ensureAntigravityMcpServers(
        {
          [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("replacement-secret"),
        },
        { HOME: home },
      );
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntries();
      restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(originalComputerEntry);
      expect(restored.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(originalAgentsEntry);
      expect(restored.mcpServers["another-helper"]).toEqual({ command: "another-mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a tool-less turn removes both reserved keys, and never creates the file just to remove", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcprm-"));
    try {
      // No file at all: removal is a no-op, not an empty file in the user's home.
      ensureAntigravityMcpServers({}, { HOME: home });
      expect(existsSync(configPath(home))).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
            [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("stale-secret"),
          },
        }),
      );
      ensureAntigravityMcpServers({}, { HOME: home });
      const config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computer and teammate MCP only on full-auto instances, and never localComputerMcp", async () => {
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
      expect(fullAuto.adapter.capabilities.agentsMcp).toBe(true);
      // accept-edits print mode auto-denies tools that would prompt, so a
      // mount there could never fire — the capability must not be offered.
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(false);
      expect(acceptEdits.adapter.capabilities.agentsMcp).toBe(false);
      // The host desktop needs per-action human approval; print mode has no
      // approval channel in any mode.
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBeUndefined();
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBeUndefined();
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("does not mount token-bearing OpenMaus tools in safe mode even when a caller supplies them", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpsafe-"));
    const dump = join(home, "mcp-at-spawn.json");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-safe",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-safe",
        text: "do not expose tools",
        integrations: { ...boxIntegrations, ...agentsIntegrations("must-not-leak") },
      });
      await recorder.until((event) => event.type === "turn.completed");

      const atSpawn = JSON.parse(readFileSync(dump, "utf8"));
      expect(atSpawn?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(atSpawn?.mcpServers?.[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
      expect(JSON.stringify(atSpawn)).not.toContain("must-not-leak");
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
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
        integrations: { ...boxIntegrations, ...agentsIntegrations("spawn-secret") },
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("spawn-secret"));
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      const atSpawn = JSON.parse(readFileSync(dump, "utf8"));
      expect(atSpawn.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(atSpawn.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("spawn-secret"));
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes overlapping turns so each child sees only its own MCP mounts and tokens", async () => {
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
      await first.adapter.sendTurn({
        threadId: "t-mcp-first",
        text: "first",
        integrations: { ...boxIntegrations, ...agentsIntegrations("first-secret") },
      });
      let secondSpawned = false;
      const secondTurn = second.adapter
        .sendTurn({
          threadId: "t-mcp-second",
          text: "second",
          integrations: agentsIntegrations("second-secret"),
        })
        .then((result) => {
          secondSpawned = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSpawned).toBe(false);
      await firstRecorder.until((event) => event.type === "turn.completed");
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      const firstConfig = JSON.parse(readFileSync(firstDump, "utf8"));
      const secondConfig = JSON.parse(readFileSync(secondDump, "utf8"));
      expect(firstConfig.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(firstConfig.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("first-secret"));
      expect(secondConfig?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(secondConfig.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("second-secret"));
      expect(JSON.stringify(secondConfig)).not.toContain("first-secret");
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
      await first.adapter.sendTurn({
        threadId: "t-mcp-zombie",
        text: "first",
        integrations: { ...boxIntegrations, ...agentsIntegrations("zombie-secret") },
      });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(readConfig(home).mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("zombie-secret"));

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

      const zombieConfig = JSON.parse(readFileSync(firstDump, "utf8"));
      const afterZombieConfig = JSON.parse(readFileSync(secondDump, "utf8"));
      expect(zombieConfig.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(zombieConfig.mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("zombie-secret"));
      expect(afterZombieConfig?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(afterZombieConfig?.mcpServers?.[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
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
    const secondDump = join(home, "second.json");
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
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({
        threadId: "t-mcp-interrupted",
        text: "first",
        integrations: { ...boxIntegrations, ...agentsIntegrations("interrupt-secret") },
      });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(readConfig(home).mcpServers[ANTIGRAVITY_AGENTS_MCP_KEY]).toEqual(agentsEntry("interrupt-secret"));
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
      const afterInterruptConfig = JSON.parse(readFileSync(secondDump, "utf8"));
      expect(afterInterruptConfig?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(afterInterruptConfig?.mcpServers?.[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
