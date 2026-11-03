// A skill past the very start of a message runs only from a person's own line. Everything else reaches the engine through
// the same turn, so this drives the real server and reads what the engine was handed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CALLED = /your standup skill/;

it("calls a skill from a later line a person typed, never from a webhook, another bot or a bot's own shell", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-skill-commands-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const base = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBeLessThan(300);
    return result;
  };
  const dump = (): any => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  const prompt = (): string => {
    const content = dump().prompt?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  };
  const reached = (marker: string) => expect.poll(prompt, { timeout: hostTimeout(30_000) }).toContain(marker);
  const quiet = () => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.some((bot: { busy?: boolean }) => bot.busy), { timeout: hostTimeout(30_000) }).toBe(false);
  let sends = 0;
  const sendId = () => `skill-e2e-send-${String(++sends).padStart(10, "0")}`;
  try {
    const home = join(fixture.info.dataDir, "task-workspaces", ".claude", "skills", "standup");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "SKILL.md"), "---\nname: standup\ndescription: Writes the standup.\n---\n\nSummarize {input}.\n");
    const opened = await api("POST", "/api/auth/pairing", { label: "Ada's phone", scopes: ["client"] });
    const person: string = (await api("POST", "/api/auth/pair", { code: opened.code, label: "Ada's phone" })).token;
    const asker = (await api("POST", "/api/bots", { name: "Asker" })).bot;
    const scout = (await api("POST", "/api/bots", { name: "Scout" })).bot;
    const say = (text: string, token?: string, extra: Record<string, unknown> = {}) =>
      api("POST", `/api/bots/${scout.id}/messages`, { threadId: scout.threadId, sendId: sendId(), text, ...extra }, token);

    // Another bot's words, at the very start and on a later line, while its own turn holds a live capability.
    await api("POST", `/api/bots/${asker.id}/messages`, { threadId: asker.threadId, sendId: sendId(), text: "asker-start" });
    await reached("asker-start");
    const comms: string = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    await api("POST", "/api/internal/coordinate-bots", { botIds: [scout.id], reply: "none", message: "/standup peer-marker\n/standup again" }, comms);
    await reached("peer-marker");
    expect(prompt()).toMatch(/^\/standup again/m);
    expect(prompt()).not.toMatch(CALLED);
    writeFileSync(gate, "finish");
    await quiet();

    // A webhook's payload, and the automation's own prompt, on a later line.
    const hook = await api("POST", "/api/webhooks", { name: "Inbox", prompt: "Handle the event.\n/standup the event", botId: scout.id });
    const delivered = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "text/plain" }, body: "webhook-marker\n/standup now" });
    expect(delivered.status).toBe(202);
    await reached("webhook-marker");
    expect(prompt()).toMatch(/^\/standup the event/m);
    expect(prompt()).not.toMatch(CALLED);
    await quiet();

    // Loopback with no session, the way a bot's own shell reaches this route on a headless server.
    await say("shell-marker\n/standup now");
    await reached("shell-marker");
    expect(prompt()).not.toMatch(CALLED);
    await quiet();

    // The person, from a paired session.
    await say("typed-marker\n/standup the billing work", person);
    await reached("typed-marker");
    expect(prompt()).toMatch(/The user called your standup skill with \/standup \(read "[^"]*SKILL\.md"\)/);
    await quiet();
    await say("/standup start-marker", person);
    await reached("start-marker");
    expect(prompt()).toMatch(/The user ran your standup skill with \/standup/);
    await quiet();
    for (const [marker, text] of [
      ["midline-marker", "Please /standup midline-marker"],
      ["fence-marker", "fence-marker\n```\n/standup\n```"],
      ["dot-marker", "dot-marker\n/standup.txt is the file"],
    ] as const) {
      await say(text, person);
      await reached(marker);
      expect(prompt(), text).not.toMatch(CALLED);
      await quiet();
    }

    // Still the person's line after it waited its turn in the queue.
    rmSync(gate);
    await say("first-marker", person);
    await reached("first-marker");
    expect((await say("queued-marker\n/standup the rest", person, { followUp: "queue" })).queued).toBe(true);
    writeFileSync(gate, "finish");
    await reached("queued-marker");
    expect(prompt()).toMatch(/The user called your standup skill/);
    await quiet();
  } finally {
    await fixture.close();
    await removeTempDir(gates);
  }
}, hostTimeout(180_000));
