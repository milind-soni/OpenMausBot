import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const EMPTY = { instanceId: "", model: "" };
const DEFAULT = { instanceId: "claude", model: "claude-sonnet-5" };
const CHOSEN = { instanceId: "claude", model: "claude-opus-5" };
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));

type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  control: (...args: string[]) => Promise<any>;
  restart: (options?: { clearStarter?: boolean; enabled?: boolean; signedOut?: boolean }) => Promise<void>;
  connect: () => Promise<void>;
  makeCliAvailable: (holdProbe?: boolean) => { started: () => boolean; release: () => void; dispatched: () => boolean };
  saved: () => any[];
  receipt: () => { model: string; prompt: unknown };
};

async function withUnselectedStarter(check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const configPath = join(dataDir, "config.json");
  const botsPath = join(dataDir, "bots.json");
  const lateCli = join(dataDir, "late-claude.mjs");
  const starterId = JSON.parse(readFileSync(botsPath, "utf8"))[0].id;
  let server: ChildProcess | undefined;
  const request: Fixture["request"] = async (method, path, body) => {
    const response = await fetch(url + path, { method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const result = await request(method, path, body);
    expect(result.status >= 200 && result.status < 300, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result.body;
  };
  const saved = (): any[] => JSON.parse(readFileSync(botsPath, "utf8"));
  const restart: Fixture["restart"] = async (options = {}) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    if (options.clearStarter) {
      const bots = saved();
      bots.find((bot) => bot.id === starterId).modelSelection = EMPTY;
      writeFileSync(botsPath, JSON.stringify(bots));
    }
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude = { ...config.instances.claude, enabled: options.enabled ?? true,
      config: { ...config.instances.claude.config, cli: lateCli },
      environment: options.signedOut ? { FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in" } : {},
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    await check({ api, request, saved, restart,
      control: (...args) => runControlOmb([...args, "--url", url]) as Promise<any>,
      connect: async () => { await api("PATCH", "/api/instances/claude", { cli: FAKE_CLI }); },
      makeCliAvailable: (holdProbe = false) => {
        const gate = join(dataDir, "probe-release");
        const probes = join(dataDir, "probe-log");
        const turns = join(dataDir, "probe-turns.jsonl");
        writeFileSync(lateCli, ["#!/usr/bin/env node",
          ...(holdProbe ? [
            `process.env.FAKE_CLAUDE_PROBE_LOG = ${JSON.stringify(probes)};`,
            `process.env.FAKE_CLAUDE_HOLD_VERSION = ${JSON.stringify(gate)};`,
            `process.env.FAKE_CLAUDE_HOLD_AUTH = ${JSON.stringify(gate)};`,
            `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(turns)};`,
          ] : []),
          `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
        ].join("\n"), { mode: 0o700 });
        return { started: () => existsSync(probes), release: () => writeFileSync(gate, "ready"), dispatched: () => existsSync(turns) };
      },
      receipt: () => {
        const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
        // Do not retain the fake provider's environment or MCP credentials.
        return { model: dump.argv[dump.argv.indexOf("--model") + 1], prompt: dump.prompt };
      },
    });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}

async function send(fixture: Fixture, botId: string, threadId: string, text: string) {
  await fixture.control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect((await fixture.control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe("settled");
  const messages = (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=20`)).messages;
  expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
  expect(fixture.receipt().model).toBe(DEFAULT.model);
  expect(JSON.stringify(fixture.receipt().prompt)).toContain(text);
}

it("connecting a provider selects a blank starter and future bot defaults without replacing chosen models", async () => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    const pinned = (await fixture.api("POST", `/api/bots/${starter.id}/tasks`, { title: "Pinned model" })).task;
    await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${pinned.threadId}`, { modelSelection: CHOSEN });
    const intentional = (await fixture.api("POST", "/api/bots", { name: "Chosen model", modelSelection: CHOSEN })).bot;
    await fixture.restart({ clearStarter: true });
    const missing = (await fixture.api("GET", "/api/instances")).instances.find((instance: any) => instance.instanceId === "claude");
    expect(missing.snapshot.state).not.toBe("available");
    expect((await fixture.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === starter.id).modelSelection).toEqual(EMPTY);

    await fixture.connect();
    const bots = (await fixture.api("GET", "/api/bots")).bots;
    const connected = bots.find((bot: any) => bot.id === starter.id);
    expect(connected.modelSelection).toEqual(DEFAULT);
    expect(connected.tasks.find((task: any) => task.threadId === starter.threadId)).toMatchObject({ modelSelection: DEFAULT, followsBotModel: true });
    expect(connected.tasks.find((task: any) => task.threadId === pinned.threadId)).toMatchObject({ modelSelection: CHOSEN, followsBotModel: false });
    expect(bots.find((bot: any) => bot.id === intentional.id).modelSelection).toEqual(CHOSEN);
    expect(fixture.saved().find((bot) => bot.id === starter.id).modelSelection).toEqual(DEFAULT);
    expect((await fixture.api("GET", "/api/bot-defaults")).modelSelection).toEqual(DEFAULT);
    expect((await fixture.control("new-bot", "--name", "New default")).bot.modelSelection).toEqual(DEFAULT);
    await send(fixture, starter.id, starter.threadId, "AUTOMATIC_FIRST_CHAT_8P");

    // Restart without altering the persisted bot choices.
    fixture.makeCliAvailable();
    await fixture.restart();
    const reloaded = (await fixture.api("GET", "/api/bots")).bots;
    expect(reloaded.find((bot: any) => bot.id === starter.id).modelSelection).toEqual(DEFAULT);
    expect(reloaded.find((bot: any) => bot.id === intentional.id).modelSelection).toEqual(CHOSEN);
    expect(reloaded.find((bot: any) => bot.id === starter.id).tasks.find((task: any) => task.threadId === pinned.threadId))
      .toMatchObject({ modelSelection: CHOSEN, followsBotModel: false });
  });
}, 120_000);

it("first send discovers a provider installed after startup without requiring the model picker", async () => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    await fixture.restart({ clearStarter: true });
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(EMPTY);
    fixture.makeCliAvailable();
    // No inventory refresh or provider-setting write between availability and send.
    await send(fixture, starter.id, starter.threadId, "LATE_PROVIDER_FIRST_CHAT_9Q");
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(DEFAULT);
    expect(fixture.saved()[0].modelSelection).toEqual(DEFAULT);
  });
}, 120_000);

it.each(["signed-out", "disabled"] as const)("does not select a %s provider for a blank starter", async (state) => {
  await withUnselectedStarter(async (fixture) => {
    fixture.makeCliAvailable();
    await fixture.restart({ clearStarter: true, signedOut: state === "signed-out", enabled: state !== "disabled" });
    const claude = (await fixture.api("GET", "/api/instances")).instances.find((instance: any) => instance.instanceId === "claude");
    if (state === "signed-out") expect(claude.snapshot.authenticated).toBe(false);
    else expect(claude.enabled).toBe(false);
    expect((await fixture.api("GET", "/api/bots")).bots[0].modelSelection).toEqual(EMPTY);
    expect(fixture.saved()[0].modelSelection).toEqual(EMPTY);
  });
}, 120_000);

it.each(["permissions", "branch"] as const)("rechecks guarded %s after held first-run provider discovery", async (change) => {
  await withUnselectedStarter(async (fixture) => {
    const starter = (await fixture.api("GET", "/api/bots")).bots[0];
    let otherLeaf: string | undefined;
    if (change === "branch") {
      await send(fixture, starter.id, starter.threadId, "EARLIER_BRANCH_BEFORE_DISCOVERY_2S");
      const original = await fixture.api("GET", `/api/threads/${starter.threadId}/messages?limit=100`);
      otherLeaf = original.activeLeafId;
      const user = original.messages.find((message: any) => message.role === "user");
      await fixture.api("POST", `/api/bots/${starter.id}/messages/${user.id}/edit`, {
        threadId: starter.threadId, text: "NEW_BRANCH_BEFORE_DISCOVERY_4U",
      });
      expect((await fixture.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
    }
    await fixture.restart({ clearStarter: true });
    await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${starter.threadId}`, { approvalMode: "ask" });
    const page = () => fixture.api("GET", `/api/threads/${starter.threadId}/messages?limit=100`);
    const before = await page();
    const probe = fixture.makeCliAvailable(true);
    const held = fixture.request("POST", `/api/bots/${starter.id}/messages/guarded`, {
      threadId: starter.threadId, sendId: randomUUID(), text: "STALE_GUARDED_DISCOVERY_MUST_NOT_DISPATCH_3T",
      expectedActiveLeafId: before.activeLeafId, expectedApprovalMode: "ask",
    });
    try {
      await expect.poll(probe.started, { timeout: 10_000 }).toBe(true);
      if (change === "permissions") {
        await fixture.api("PATCH", `/api/bots/${starter.id}/tasks/${starter.threadId}`, { approvalMode: "auto" });
      } else {
        await fixture.api("POST", `/api/bots/${starter.id}/active-branch`, { threadId: starter.threadId, messageId: otherLeaf });
      }
      const current = await page();
      if (change === "branch") expect(current.activeLeafId).not.toBe(before.activeLeafId);
      probe.release();
      expect(await held).toMatchObject({ status: 409, body: { code: `guarded_${change}` } });
      expect((await page()).messages).toEqual(current.messages);
      expect(probe.dispatched()).toBe(false);
      expect((await fixture.api("GET", "/api/bots?messages=0")).botQueuedMessages?.[starter.threadId] ?? []).toEqual([]);
    } finally {
      probe.release();
      await held;
    }
  });
}, 120_000);

it("a genuine first install stays unset until its provider account becomes ready", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in" });
  const { url, dataDir, logPath } = fixture.info;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const starter = (await api("GET", "/api/bots")).bots[0];
    expect(starter.modelSelection).toEqual(EMPTY);
    const signedInCli = join(dataDir, "signed-in-claude.mjs");
    writeFileSync(signedInCli,
      `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_AUTH = "in";\nprocess.env.FAKE_CLAUDE_MODE = "happy";\nawait import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});\n`,
      { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: signedInCli });
    expect((await api("GET", "/api/bots")).bots[0].modelSelection).toEqual(DEFAULT);
    const target = ["--bot", starter.id, "--task", starter.threadId, "--url", url];
    await runControlOmb(["send", ...target, "--text", "FIRST_INSTALL_PROVIDER_READY_1R"]);
    expect((await runControlOmb(["wait", ...target, "--timeout", "30"]) as any).status).toBe("settled");
    expect((await api("GET", `/api/threads/${starter.threadId}/messages?limit=20`)).messages
      .findLast((message: any) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
  } finally {
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}, 120_000);
