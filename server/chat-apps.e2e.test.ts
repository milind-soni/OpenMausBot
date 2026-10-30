import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { BOT_HTML_CSP } from "../shared/app-frame/csp.ts";
import { CSP_META_PREFIX } from "../shared/app-frame/document.ts";
import { APP_SAMPLES } from "../shared/app-samples.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("shows, replaces and serves a bot's page, and carries its context and its message to the engine", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-chat-apps-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_VERSION: "2.1.270" });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, status: response.status, result: path.endsWith("/app") ? { ...result, srcdoc: `${String(result.srcdoc).slice(0, 200)}…` } : result });
    expect(response.status, JSON.stringify(result).slice(0, 400)).toBe(expected);
    return result;
  };
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  const turnPrompt = (): string => {
    const content = dump().prompt?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const settledTurn = () => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy,
      { timeout: 15_000 }).toBe(false);
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const card = (body: unknown, expected: number, token: string) => api("POST", "/api/internal/options-card", body, expected, token);

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Count my coffees", sendId: "apps-e2e-send-000000001" }, 202);
    let token = "";
    await expect.poll(() => {
      try { token = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    expect(await card({ tool: "show_html", html: "", title: "Empty" }, 400, token)).toMatchObject({ error: expect.stringMatching(/^html:/) });
    const shown = await card({ tool: "show_html", ...APP_SAMPLES.counter }, 201, token);
    expect(shown).toEqual({ messageId: expect.any(String) });
    expect(await card({ tool: "update_html", app_id: shown.messageId, html: APP_SAMPLES.counter!.html.replace("Cups of coffee today", "Cups today"), title: "Coffee" }, 201, token))
      .toEqual({ messageId: shown.messageId });
    expect(await card({ tool: "update_html", app_id: "no-such-message", html: "<p>x</p>" }, 404, token)).toEqual({ error: "No page with that id in this conversation." });
    writeFileSync(gate, "finish");
    await settledTurn();

    const row = (await transcript()).find((message) => message.id === shown.messageId);
    expect(row).toMatchObject({ role: "bot", kind: "app", text: expect.stringMatching(/^\[App\] Coffee\n/), app: { v: 1, source: "html", title: "Coffee", rev: 1, border: true, height: 200 } });
    expect(row).not.toHaveProperty("from");

    const doc = await api("GET", `/api/threads/${bot.threadId}/messages/${shown.messageId}/app`);
    expect(doc).toMatchObject({ v: 1, messageId: shown.messageId, rev: 1, csp: BOT_HTML_CSP, can: { serverTools: false, message: true } });
    expect(String(doc.srcdoc).startsWith(`${CSP_META_PREFIX}${BOT_HTML_CSP}">`)).toBe(true);
    expect(String(doc.srcdoc)).toContain("Cups today");
    expect(await api("POST", `/api/bots/${bot.id}/apps/${shown.messageId}/rpc`, { threadId: bot.threadId, method: "tools/list" }, 404)).toEqual({ error: "That app has no server to call." });

    expect(await api("POST", `/api/bots/${bot.id}/apps/${shown.messageId}/context`, { threadId: bot.threadId, content: [{ type: "text", text: "The counter shows 3 cups." }] })).toEqual({ ok: true });
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, {
      threadId: bot.threadId, sendId: "apps-e2e-send-000000002", appMessage: { messageId: shown.messageId, text: "I have had 3 cups of coffee today." },
    }, 202);
    expect(sent.message).toMatchObject({ role: "user", text: "I have had 3 cups of coffee today.", replyToId: shown.messageId, fromApp: { messageId: shown.messageId, title: "Coffee" } });
    await expect.poll(turnPrompt, { timeout: 15_000 }).toContain("sent from an app shown in this chat");
    const prompt = turnPrompt();
    evidence.push({ prompt });
    expect(prompt).toContain([
      "--- app context ---",
      "Coffee (a page you made with show_html), as the person sees it now:",
      "The counter shows 3 cups.",
      "--- end app context ---",
      "",
      "The current message was sent from an app shown in this chat after the person pressed something in it: Coffee (a page you made with show_html).",
    ].join("\n"));
    expect(prompt).toContain("--- app ---\nCoffee\n--- end app ---\nCurrent message:\nI have had 3 cups of coffee today.");
    writeFileSync(gate, "finish");
    await settledTurn();

    // The context was handed over once: the next message carries none.
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, sendId: "apps-e2e-send-000000003", text: "Thanks" }, 202);
    await expect.poll(turnPrompt, { timeout: 15_000 }).toContain("Thanks");
    expect(turnPrompt()).not.toContain("--- app context ---");
    writeFileSync(gate, "finish");
    await settledTurn();

    const after = await transcript();
    expect(after.find((message) => message.id === shown.messageId).app.context).toMatchObject({ text: "The counter shows 3 cups.", delivered: true });
    const exported = await (await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/export`, { headers: { origin: fixture.info.url } })).text();
    expect(exported).toContain("[App] Coffee");
  } finally {
    const evidencePath = `${fixture.info.logPath}.chat-apps.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close();
    await removeTempDir(gates);
  }
}, 90_000);
