// The per-pair peer allow-list, end to end against the real harness server.
//
// Two claims are pinned here that no unit can reach: an ordinary (non-Chief)
// bot's system prompt now names its teammates, and `peers` narrows what that
// bot can see AND what the internal comms endpoints will let it do. The
// endpoints are sealed behind a per-boot token, so — as in
// room-chat-wait.e2e.test.ts — the token is read out of the MCP config the
// fake CLI dumps on its first turn.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const REFUSED = "not on this bot's allowed peers";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let askerDump = "";
let boundDump = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, dump?: string) => ({
  driver: "claudeAgent",
  displayName,
  environment: { FAKE_CLAUDE_MODE: "happy", ...(dump ? { FAKE_CLAUDE_DUMP: dump } : {}) },
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-peer-allowlist-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Peer allow-list test</title>");
  askerDump = join(home, "asker-dump.json");
  boundDump = join(home, "bound-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      plain: fixture("Plain fixture"),
      // the dump is the only place a test can read the per-boot comms token
      // — and the only place it can read a bot's assembled system prompt
      asker: fixture("Asker fixture", askerDump),
      bound: fixture("Allow-listed fixture", boundDump),
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const readDump = (path: string) => (): { systemPrompt?: string; mcpConfig?: any } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // not written yet, or mid-write
    return undefined;
  }
};

const botBusy = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
};

const peerNames = async (selfId: string, token: string) => {
  const listed = await api(
    "GET",
    `/api/internal/agents?self=${encodeURIComponent(selfId)}`,
    undefined,
    { authorization: `Bearer ${token}` },
  );
  expect(listed.status).toBe(200);
  return (listed.body.bots as Array<{ name: string }>).map((bot) => bot.name).sort();
};

describe("peer allow-list", () => {
  it("gives an ordinary bot a roster, then narrows it and the comms endpoints", async () => {
    // the seeded bot would otherwise join the unsectioned team and make the
    // roster assertions depend on install order
    const seeded = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const asker = await createBot("Ada", "asker");
    const quill = await createBot("Quill", "plain");
    const patch = await createBot("Patch", "plain");

    try {
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Warm up" })).status).toBe(202);
      await expect.poll(() => readDump(askerDump)()?.systemPrompt, { timeout: 10_000 }).toBeTruthy();
      const dump = readDump(askerDump)()!;

      // 1. an ordinary bot is finally told who its teammates are
      const systemPrompt = String(dump.systemPrompt);
      expect(systemPrompt).toContain("Bots you can reach:");
      expect(systemPrompt).toContain("- Quill — General assistant (available)");
      expect(systemPrompt).toContain("- Patch — General assistant (available)");
      // and is told nothing about creating bots or directing them
      expect(systemPrompt).toContain("peers, not staff");
      expect(systemPrompt).not.toContain("create_bot");

      const token = String(dump.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN ?? "");
      expect(token).toBeTruthy();
      await expect.poll(() => botBusy(asker.id)).toBe(false);

      // 2. with no allow-list set, both peers are visible and reachable
      expect(await peerNames(asker.id, token)).toEqual(["Patch", "Quill"]);
      const openAsk = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: patch.id, message: "Patch, still there?" },
        { authorization: `Bearer ${token}` },
      );
      expect(openAsk.status).toBe(200);
      await expect.poll(() => botBusy(patch.id)).toBe(false);

      // 3. wiring Ada to Quill alone narrows the listing list_bots reads…
      expect((await api("PATCH", `/api/bots/${asker.id}`, { peers: [quill.id] })).status).toBe(200);
      expect(await peerNames(asker.id, token)).toEqual(["Quill"]);

      // …and both endpoints, for the peer that is now off the list
      const refusedAsk = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: patch.id, message: "Patch, one more thing" },
        { authorization: `Bearer ${token}` },
      );
      expect(refusedAsk.status).toBe(403);
      expect(String(refusedAsk.body.error)).toContain(REFUSED);
      const refusedDelegation = await api(
        "POST",
        "/api/internal/delegate-bot",
        { fromBotId: asker.id, toBotId: patch.id, message: "Patch, take this" },
        { authorization: `Bearer ${token}` },
      );
      expect(refusedDelegation.status).toBe(403);
      expect(String(refusedDelegation.body.error)).toContain(REFUSED);

      // the peer that is still wired is untouched
      const allowedDelegation = await api(
        "POST",
        "/api/internal/delegate-bot",
        { fromBotId: asker.id, toBotId: quill.id, message: "Quill, take this" },
        { authorization: `Bearer ${token}` },
      );
      expect(allowedDelegation.status).toBe(200);
      expect(allowedDelegation.body.queued).toBe(true);
    } finally {
      for (const bot of [asker, quill, patch]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);

  it("renders only the allow-listed peers into the roster the bot is given", async () => {
    const seeded = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const bound = await createBot("Dot", "bound");
    const near = await createBot("Near", "plain");
    const far = await createBot("Farside", "plain");

    try {
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [near.id] })).status).toBe(200);
      expect((await api("POST", `/api/bots/${bound.id}/messages`, { text: "Warm up" })).status).toBe(202);
      await expect.poll(() => readDump(boundDump)()?.systemPrompt, { timeout: 10_000 }).toBeTruthy();

      const systemPrompt = String(readDump(boundDump)()!.systemPrompt);
      expect(systemPrompt).toContain("- Near — General assistant (available)");
      // the roster can never name a peer this bot's own ask_bot would refuse
      expect(systemPrompt).not.toContain("Farside");
    } finally {
      for (const bot of [bound, near, far]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);
});
