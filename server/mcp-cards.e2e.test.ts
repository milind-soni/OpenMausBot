import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

async function onAsk(run: (f: {
  api: (method: string, path: string, body?: unknown, expected?: number, token?: string) => Promise<any>;
  dump: () => any; config: () => any; iris: { id: string; threadId: string }; card: () => Promise<any>; parkOnCard: () => Promise<any>; idle: () => Promise<void>;
}) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-mcp-card-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
  const config = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  try {
    const iris = (await api("POST", "/api/bots", { name: "Iris" }, 201)).bot;
    await api("PATCH", `/api/bots/${iris.id}`, { approvalMode: "ask" });
    const card = async () => (await api("GET", `/api/threads/${iris.threadId}/messages`)).messages.find((message: any) => message.card?.mcpRequest);
    const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((bot: any) => !bot.busy), { timeout: 20_000 }).toBe(true);
    const parkOnCard = async () => {
      await api("POST", `/api/bots/${iris.id}/messages`, { threadId: iris.threadId, text: "Add the notes server", sendId: "mcp-card-e2e-send-0001" }, 202);
      let first: any;
      await expect.poll(() => { first = dump(); return JSON.stringify(first?.prompt ?? "").includes("Add the notes server"); }, { timeout: 20_000 }).toBe(true);
      const token: string = first.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      const added = await api("POST", "/api/internal/mcp-servers", { action: "add", name: "notes", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_MCP] }, 201, token);
      expect(added.text).toContain("A card is now visible to the person. End this turn and wait for the decision.");
      expect(config().mcpServers.notes.enabled).toBe(false);
      writeFileSync(gate, "");
      let shown: any;
      await expect.poll(async () => { shown = await card(); return shown?.card.title; }, { timeout: 20_000 }).toBe("Turn on notes?");
      await idle();
      return shown;
    };
    await run({ api, dump, config, iris, card, parkOnCard, idle });
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

it("a bot on Ask adds a server switched off, the person taps Turn on, and the bot resumes with the test result and the server's tools", () => onAsk(async ({ api, dump, config, iris, card, parkOnCard, idle }) => {
  const shown = await parkOnCard();
  expect(shown.card).toMatchObject({ options: ["Turn on", "Cancel"], tool: "mcp_server", mcpRequest: { action: "enable", name: "notes" } });
  expect(shown.card.subtitle).toMatch(/fake-mcp-server\.ts\nRuns on this computer\.$/u);

  const answered = await api("POST", `/api/threads/${iris.threadId}/respond`, { requestId: shown.card.requestId, behavior: "allow" });
  expect(answered).toMatchObject({ ok: true, alreadySettled: false, result: { state: "applied" } });
  expect(config().mcpServers.notes.enabled).toBe(true);

  let resumed: any;
  await expect.poll(() => { resumed = dump(); return JSON.stringify(resumed?.prompt ?? "").includes("OpenMausBot MCP server decision"); }, { timeout: 20_000 }).toBe(true);
  expect(JSON.stringify(resumed.prompt)).toContain("Test: it started and listed its tools: read_notes.");
  expect(resumed.mcpConfig.mcpServers.notes, "the resumed turn already has the server").toBeDefined();
  await expect.poll(async () => (await card()).card.mcpRequest.resumed, { timeout: 20_000 }).toBe(true);
  expect((await card()).card.answered).toBe("allow");
  // A local browser's approval is refused while any bot works, and the resumed turn may still be working.
  await idle();
  expect((await api("POST", `/api/threads/${iris.threadId}/respond`, { requestId: shown.card.requestId, behavior: "allow" })).alreadySettled).toBe(true);
}), 90_000);

it("Stop closes the open card, and a later Turn on applies nothing", () => onAsk(async ({ api, config, iris, card, parkOnCard }) => {
  const shown = await parkOnCard();
  await api("POST", `/api/bots/${iris.id}/interrupt`, { threadId: iris.threadId });
  await expect.poll(async () => (await card()).card.dismissed, { timeout: 20_000 }).toBe(true);
  expect((await card()).card.answered).toBe("unavailable");
  expect((await api("POST", `/api/threads/${iris.threadId}/respond`, { requestId: shown.card.requestId, behavior: "allow" })).alreadySettled).toBe(true);
  expect(config().mcpServers.notes.enabled).toBe(false);
}), 90_000);
