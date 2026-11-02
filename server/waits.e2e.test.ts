import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { WAIT_MESSAGES } from "./routes/waits.ts";
import { removeTempDir } from "./testing/cleanup.ts";

async function scout(name: string) {
  const folder = mkdtempSync(join(tmpdir(), `omb-waits-${name}-`));
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
  const close = async () => {
    writeFileSync(`${fixture.info.logPath}.waits-${name}.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    await removeTempDir(folder);
  };
  const bot = await api("POST", "/api/bots", { name: "Scout" }, 201).then((made) => made.bot, async (error: unknown) => { await close(); throw error; });
  const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy;
  const settledTurn = () => expect.poll(busy, { timeout: 15_000 }).toBe(false);
  const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
  const send = (text: string) => runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", fixture.info.url]);
  return { folder, gate, api, bot, busy, settledTurn, transcript, send, turnPrompt, turnToken, close };
}

it("waits for a file with no AI, posts once in the asked chat, notifies, and continues there; Cancel on its card stops another", async () => {
  const { folder, gate, api, bot, settledTurn, transcript, send, turnToken, close } = await scout("fires");
  const report = join(folder, "report.txt"), present = join(folder, "present.txt"), other = join(folder, "other.txt");
  try {
    await send("Tell me when the report is ready");
    const token = await turnToken();
    const made = await api("POST", "/api/internal/waits", { label: "the report", kind: "file_exists", path: report, follow_up: "Say the report is ready." }, 201, token);
    expect(made.text).toMatch(/\(wait id [\w-]+\)/);
    writeFileSync(present, "x");
    expect((await api("POST", "/api/internal/waits", { label: "present", kind: "file_exists", path: present }, 200, token)).text).toContain("already. Nothing was set up");
    await api("POST", "/api/internal/waits", { label: "the other file", kind: "file_exists", path: other, follow_up: "Never." }, 201, token);
    const cards = (await transcript()).filter((m) => m.card?.waitRequest);
    expect(cards.map((m) => m.card.title)).toEqual(["Waiting: the report", "Waiting: the other file"]);
    await api("POST", `/api/threads/${bot.threadId}/undo`, { requestId: cards[1].card.requestId }, 200);
    expect((await transcript()).find((m) => m.id === cards[1].id).card).toMatchObject({ undone: true, waitRequest: { settled: "cancelled" } });
    writeFileSync(gate, "finish"); await settledTurn();
    writeFileSync(report, "done"); writeFileSync(other, "x");
    await expect.poll(async () => (await transcript()).filter((m) => m.wait?.status === "fired").map((m) => m.text), { timeout: 30_000 })
      .toEqual([`the report: done. ${report} is there now.`]);
    await expect.poll(async () => (await transcript()).some((m) => m.role === "user" && m.text?.includes("[Wait finished: the report] Say the report is ready.")), { timeout: 40_000 }).toBe(true);
    expect((await api("GET", "/api/notifications")).notifications.filter((n: any) => n.kind === "wait")).toMatchObject([{ title: "Scout's wait is over" }]);
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect((await transcript()).filter((m) => m.wait).length).toBe(1);
  } finally {
    await close();
  }
}, 120_000);

it("refuses a new wait in the run a wait's follow-up started, so a wait never renews itself", async () => {
  const { folder, gate, api, busy, settledTurn, transcript, send, turnPrompt, turnToken, close } = await scout("renew");
  const build = join(folder, "build.txt");
  try {
    await send("Tell me when the build is done");
    const asked = await turnToken();
    await api("POST", "/api/internal/waits", { label: "the build", kind: "file_exists", path: build, follow_up: "Wait for the build again." }, 201, asked);
    writeFileSync(gate, "finish"); await settledTurn(); unlinkSync(gate);
    writeFileSync(build, "x");
    await expect.poll(turnPrompt, { timeout: 40_000 }).toContain("[Wait finished: the build] Wait for the build again.");
    expect(await busy()).toBe(true);
    const followUp = await turnToken();
    expect(await api("GET", "/api/internal/waits", undefined, 200, followUp)).toEqual({ text: WAIT_MESSAGES.none });
    const again = { label: "the build", kind: "file_changed", path: build, follow_up: "Wait for the build again." };
    expect(await api("POST", "/api/internal/waits", again, 403, followUp)).toEqual({ error: WAIT_MESSAGES.notPerson });
    expect(await api("POST", "/api/internal/waits/cancel", { id: "any" }, 403, followUp)).toEqual({ error: WAIT_MESSAGES.notPerson });
    writeFileSync(gate, "finish"); await settledTurn();
    expect((await transcript()).filter((m) => m.card?.waitRequest).map((m) => m.card.waitRequest)).toMatchObject([{ label: "the build", settled: "fired" }]);
  } finally {
    await close();
  }
}, 120_000);
