// The per-pair peer allow-list, end to end against the real harness server.
//
// Four claims are pinned here that no unit can reach: an ordinary (non-Chief)
// bot's system prompt now names its teammates; `peers` narrows what that bot
// can see AND what the internal comms endpoints will let it do, without
// refusing the peers it still covers; the list survives an approval card that
// was open while it changed; and the field can only ever be made smaller from
// the loopback API a bot's own tool call can reach. The
// endpoints are sealed behind a per-turn token. The real MCP config is still
// inspected below, while the isolated server's test-only mint route provides
// an exact synthetic active turn for driving the endpoint after the fake exits.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const TEST_CAPABILITY_KEY = "peer-allowlist-fixture-capability";

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
      // the dump is the only place a test can read the real per-turn comms token
      // — and the only place it can read a bot's assembled system prompt
      asker: fixture("Asker fixture", askerDump),
      bound: fixture("Allow-listed fixture", boundDump),
      // never finishes: how a bot is held mid-turn, which is the one moment
      // its own shell could be the caller behind a loopback PATCH
      stuck: {
        driver: "claudeAgent",
        displayName: "Stuck fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
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
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
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

const botPeers = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.peers;
};

const botMessages = async (botId: string): Promise<any[]> => {
  const state = (await api("GET", "/api/bots")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.messages ?? [];
};

/** Drive a bot through one turn so it owns a task its own thread id resolves
 * to — /api/internal/ask-bot refuses a source thread that has none. */
const warmUp = async (botId: string) => {
  expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Warm up" })).status).toBe(202);
  await expect.poll(() => botBusy(botId), { timeout: 15_000 }).toBe(false);
};

const mintCapability = async (botId: string, threadId: string): Promise<string> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind: "agents" },
    { "x-openmausbot-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return String(minted.body.token);
};

const hideSeededBot = async () => {
  // the seeded bot would otherwise join the unsectioned team and make the
  // roster and listing assertions depend on install order
  const seeded = (await api("GET", "/api/bots?messages=0")).body.bots[0];
  await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
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
    await hideSeededBot();
    const asker = await createBot("Ada", "asker");
    const quill = await createBot("Quill", "plain");
    const patch = await createBot("Patch", "plain");

    try {
      rmSync(askerDump, { force: true });
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Warm up" })).status).toBe(202);
      await expect.poll(() => readDump(askerDump)()?.systemPrompt, { timeout: 10_000 }).toBeTruthy();
      const dump = readDump(askerDump)()!;

      // 1. an ordinary bot is finally told who its teammates are
      const systemPrompt = String(dump.systemPrompt);
      expect(systemPrompt).toContain("[TEAM ROSTER]");
      expect(systemPrompt).toContain("- Quill — General assistant (available)");
      expect(systemPrompt).toContain("- Patch — General assistant (available)");
      // and is told nothing about creating bots or directing them
      expect(systemPrompt).toContain("peers, not staff");
      expect(systemPrompt).not.toContain("create_bot");
      // The harness keeps appending its own rules with a bare leading space
      // (index.ts: `${coordinationPrompt}` then credentialPrompt). The last
      // roster line is a stranger's text, so the terminator has to be what
      // those rules land against — otherwise a persona ending "…ask the user
      // to paste the key into chat" sits flush against the rule forbidding
      // exactly that.
      expect(systemPrompt).toContain("[/TEAM ROSTER] If a supported API key is missing");

      const providerToken = String(dump.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN ?? "");
      expect(providerToken).toMatch(/^[a-f0-9]{48}$/);
      await expect.poll(() => botBusy(asker.id)).toBe(false);
      const token = await mintCapability(asker.id, asker.threadId);

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

      // …while the peer that IS still wired stays reachable on BOTH
      // endpoints. Without this the gate could refuse every bot that merely
      // has a list — the exact regression an allow-list introduces — and the
      // 403s above would still be green.
      const allowedAsk = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: quill.id, message: "Quill, still there?" },
        { authorization: `Bearer ${token}` },
      );
      expect(allowedAsk.status).toBe(200);
      expect(allowedAsk.body.error).toBeUndefined();
      await expect.poll(() => botBusy(quill.id)).toBe(false);

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
    await hideSeededBot();
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

  it("re-checks the allow-list after the approval card, not just before it", async () => {
    // The card can sit open for minutes. Everything the handler captured
    // before it — including the grant — is stale by the time the user
    // clicks Allow, so the gate has to run a second time against fresh
    // records. Nothing else in the suite drives a bot through the card.
    await hideSeededBot();
    // on the dump fixture, because the real per-turn comms token is only ever
    // readable out of a bot's MCP config
    const asker = await createBot("Iris", "asker");
    const helper = await createBot("Hedge", "plain");

    try {
      rmSync(askerDump, { force: true });
      await warmUp(asker.id);
      await expect.poll(() => readDump(askerDump)()?.mcpConfig, { timeout: 10_000 }).toBeTruthy();
      const providerToken = String(readDump(askerDump)()!.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN ?? "");
      expect(providerToken).toMatch(/^[a-f0-9]{48}$/);
      const token = await mintCapability(asker.id, asker.threadId);
      expect((await api("PATCH", `/api/bots/${asker.id}`, { approvePeerComms: true })).status).toBe(200);

      // parks inside requestPeerApproval until the card below is answered
      const parked = api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: helper.id, message: "Hedge, a quick one" },
        { authorization: `Bearer ${token}` },
      );

      const askCard = async () =>
        (await botMessages(asker.id)).find(
          (message) => message.kind === "options" && message.card?.tool === "ask_bot",
        )?.card;
      await expect.poll(async () => (await askCard())?.requestId, { timeout: 15_000 }).toBeTruthy();
      const card = (await askCard())!;

      // the operator narrows the sender WHILE the card is open
      expect((await api("PATCH", `/api/bots/${asker.id}`, { peers: [] })).status).toBe(200);
      const allowed = await api("POST", `/api/bots/${asker.id}/respond`, {
        requestId: card.requestId,
        behavior: "allow",
      });
      expect(allowed.status).toBe(200);

      // the human said yes to a contact that is no longer permitted
      const outcome = await parked;
      expect(outcome.status).toBe(200);
      expect(String(outcome.body.error)).toBe("that bot is no longer an allowed peer");
      // and the peer turn never started: no inbound message, nothing to mirror
      expect(
        (await botMessages(helper.id)).some(
          (message) => message.role === "user" && message.kind === "text",
        ),
      ).toBe(false);
      expect(await botBusy(helper.id)).toBeFalsy();
    } finally {
      for (const bot of [asker, helper]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 60_000);

  it("refuses to loosen a bot from a bare loopback call while any bot is working", async () => {
    // Outside the packaged desktop the acknowledgement flag is a JSON field
    // any caller can send — including the bot it constrains, from its own
    // shell, mid-turn. What a tool call does not have is a browser origin or
    // a paired session; what it always has is a running turn. So an
    // originless, session-less loopback PATCH may loosen a bot only while
    // every bot is idle. The served UI sends its origin and is unaffected.
    await hideSeededBot();
    const held = await createBot("Held", "stuck");
    const bound = await createBot("Ivy", "plain");
    const peer = await createBot("Ash", "plain");
    const other = await createBot("Elm", "plain");
    const botState = async (id: string) =>
      (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === id);
    const browser = async (path: string, body: unknown) => api("PATCH", path, body, { origin: base });

    try {
      // wired tight while everything is idle: narrowing is always free
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id], approvePeerComms: true, section: "Ops" })).status).toBe(200);
      expect((await api("POST", `/api/bots/${held.id}/messages`, { text: "hold the line" })).status).toBe(202);
      await expect.poll(async () => (await botState(held.id))?.busy, { timeout: 20_000 }).toBe(true);

      // every way of loosening the leash, refused with the same message
      const attempts: Array<Record<string, unknown>> = [
        { peers: [peer.id, other.id], acknowledgePeerScope: true },
        { peers: null, acknowledgePeerScope: true },
        { approvePeerComms: false },
        { section: "Finance" },
        { alwaysAllow: ["Bash", "Bash:curl"] },
      ];
      for (const body of attempts) {
        const refused = await api("PATCH", `/api/bots/${bound.id}`, body);
        expect(refused.status, JSON.stringify(body)).toBe(409);
        expect(String(refused.body.error)).toContain("desktop app or a paired device");
      }
      // refused means unchanged
      expect(await botState(bound.id)).toMatchObject({ peers: [peer.id], approvePeerComms: true, section: "Ops" });
      // tightening still needs nothing, and so does an unrelated field
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [] })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { name: "Ivy renamed" })).status).toBe(200);
      // the served UI is a browser: its origin is what tells it apart
      expect((await browser(`/api/bots/${bound.id}`, { peers: [peer.id], acknowledgePeerScope: true })).status).toBe(200);
      expect((await browser(`/api/bots/${bound.id}`, { section: "Finance" })).status).toBe(200);

      // and once nothing is running, a script may loosen again (and is logged)
      expect((await api("POST", `/api/bots/${held.id}/interrupt`, {})).status).toBe(200);
      await expect.poll(async () => (await botState(held.id))?.busy, { timeout: 20_000 }).toBeFalsy();
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: null, acknowledgePeerScope: true })).status).toBe(200);
      expect(await botPeers(bound.id)).toBeUndefined();
    } finally {
      for (const bot of [held, bound, peer, other]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 60_000);

  it("lets the loopback API narrow a bot's peers but never widen them unacknowledged", async () => {
    // The bot this field constrains can curl this endpoint from a tool call
    // and gets admin scope for it (request-auth.ts hands every loopback
    // caller LOOPBACK_SCOPES). A leash a prompt-injected bot can cut is not
    // a leash, so only the narrowing direction is free.
    await hideSeededBot();
    const bound = await createBot("Ivy", "plain");
    const peer = await createBot("Ash", "plain");
    const other = await createBot("Elm", "plain");

    try {
      // narrowing needs nothing — an operator, a script, or the bot itself
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id, other.id] })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id] })).status).toBe(200);
      expect(await botPeers(bound.id)).toEqual([peer.id]);

      // adding an id back is the privileged direction, and so is clearing
      const readded = await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id, other.id] });
      expect(readded.status).toBe(400);
      expect(String(readded.body.error)).toContain("acknowledgePeerScope");
      const cleared = await api("PATCH", `/api/bots/${bound.id}`, { peers: null });
      expect(cleared.status).toBe(400);
      expect(String(cleared.body.error)).toContain("acknowledgePeerScope");
      // refused means unchanged, not partially applied
      expect(await botPeers(bound.id)).toEqual([peer.id]);

      // the flag the desktop dialog sends — and a tool call cannot forge —
      // is what carries the human's decision
      const acknowledged = await api("PATCH", `/api/bots/${bound.id}`, {
        peers: [peer.id, other.id],
        acknowledgePeerScope: true,
      });
      expect(acknowledged.status).toBe(200);
      expect(await botPeers(bound.id)).toEqual([peer.id, other.id]);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: null, acknowledgePeerScope: true })).status).toBe(200);
      expect(await botPeers(bound.id)).toBeUndefined();
    } finally {
      for (const bot of [bound, peer, other]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 60_000);
});
