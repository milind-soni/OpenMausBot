// A bot checks back later by itself: the fake engine's turn sets a check-back through the real internal route, nobody
// presses anything, and at its time the same bot takes a turn in the same conversation with the note. The line in the
// chat moves from pending to started; Cancel on another one stops it. It proves timing, place and provenance, not a
// model's judgement.
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("wakes the same bot in the same conversation at its time with no human action, and Cancel stops another", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-check-backs-"));
  const gate = join(folder, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  const turnPrompt = (): string => {
    try {
      const content = dump().prompt?.message?.content;
      return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
    } catch { return ""; }
  };
  const turnToken = async () => {
    let token = "";
    await expect.poll(() => {
      try { token = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    return token;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    const lines = async () => (await transcript()).filter((m) => m.checkBack).map((m) => m.checkBack);

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Merge it, then check CI in a minute", "--url", fixture.info.url]);
    const asked = await turnToken();
    const made = await api("POST", "/api/internal/check-backs", { when: "in 1 minute", note: "see if CI passed" }, 201, asked);
    expect(made.text).toMatch(/check-back id [\w-]+/);
    await api("POST", "/api/internal/check-backs", { when: "in 2 hours", note: "never" }, 201, asked);
    expect(await lines()).toMatchObject([{ status: "pending", note: "see if CI passed" }, { status: "pending", note: "never" }]);
    const second = (await lines())[1];
    await api("POST", `/api/check-backs/${second.id}/cancel`, undefined, 200);
    expect((await lines())[1]).toMatchObject({ status: "cancelled" });
    expect(await api("POST", "/api/internal/check-backs", { when: "in 20 seconds", note: "too soon" }, 409, asked)).toMatchObject({ error: expect.stringContaining("less than a minute") });

    writeFileSync(gate, "finish");
    await expect.poll(busy, { timeout: 15_000 }).toBe(false);
    unlinkSync(gate);

    await expect.poll(turnPrompt, { timeout: 90_000, interval: 500 }).toContain("What to check: see if CI passed");
    expect(turnPrompt()).toContain("[Check back:");
    const woken = await turnToken();
    expect(await lines()).toMatchObject([{ status: "started" }, { status: "cancelled" }]);
    const rows = await transcript();
    expect(rows.filter((m) => m.card && !m.card.answered && !m.card.dismissed)).toEqual([]);
    expect(rows.filter((m) => m.role === "user" && String(m.text ?? "").includes("[Check back:"))).toEqual([]);

    const again = await api("POST", "/api/internal/check-backs", { when: "in 5 minutes", note: "look at CI once more" }, 201, woken);
    expect(again.text).toContain("You will be woken here");
    writeFileSync(gate, "finish");
    await expect.poll(busy, { timeout: 15_000 }).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "check-backs.json"), "utf8")).checkBacks.map((c: any) => [c.threadId, c.note]))
      .toEqual([[bot.threadId, "look at CI once more"]]);
  } finally {
    writeFileSync(`${fixture.info.logPath}.check-backs.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    await removeTempDir(folder);
  }
}, 180_000);

it("sets a check-back through the real tool call on a bot at Ask, with no card and no question", async () => {
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ server: "agents", name: "check_back", input: { when: "in 2 hours", note: "see if the client replied" } }]),
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const made = await api("POST", "/api/bots", { name: "Scout" });
    expect(made.status).toBe(201);
    const bot = made.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" })).status).toBe(200);
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Chase the client in two hours if they haven't replied", "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "60", "--url", fixture.info.url]);
    const rows = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    expect(rows.filter((m) => m.checkBack).map((m) => m.checkBack)).toMatchObject([{ status: "pending", note: "see if the client replied" }]);
    expect(rows.filter((m) => m.kind === "options" || m.card)).toEqual([]);
    expect(rows.filter((m) => m.role === "user" && String(m.text ?? "").includes("[Check back:"))).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 120_000);
