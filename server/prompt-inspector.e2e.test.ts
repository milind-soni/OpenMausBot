import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";

it("captures private and group turns through the real server and removes deleted conversations", async () => {
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url), control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    const { bot } = await control("new-bot", "--name", "Capture fixture") as { bot: { id: string; threadId: string } };
    const saved = (await api("GET", "/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === bot.id);
    bot.threadId = saved.tasks[0].threadId;
    const endpoint = `/api/threads/${bot.threadId}/prompt-inspector`;
    expect((await api("GET", endpoint)).records).toEqual([]);
    await control("send", "--bot", bot.id, "--text", "Describe what was supplied.");
    await control("wait", "--bot", bot.id, "--timeout", "30");
    const first = (await api("GET", endpoint)).records;
    expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ threadId: bot.threadId, botId: bot.id, kind: "agent-input", status: "completed" });
    expect(JSON.stringify(first[0].body)).toContain("Describe what was supplied.");
    const { group } = await api("POST", "/api/groups", { name: "Capture group", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Reply in this room." });
    await expect.poll(async () => (await api("GET", `/api/threads/${group.threadId}/prompt-inspector`)).records[0]?.status, { timeout: 30_000 }).toBe("completed");
    const room = (await api("GET", `/api/threads/${group.threadId}/prompt-inspector`)).records[0];
    expect(room.botId).toBe(bot.id); expect(JSON.stringify(room.body)).toContain("Reply in this room.");
    expect((await api("GET", endpoint)).records[0].id).toBe(first[0].id);
    const capture = join(fixture.info.dataDir, "prompt-inspector", group.threadId + ".json");
    await expect.poll(() => { try { return JSON.parse(readFileSync(capture, "utf8"))[0]?.status; } catch { return null; } }).toBe("completed");
    mkdirSync(capture + ".tmp");
    const failed = await fetch(`${fixture.info.url}/api/groups/${group.id}`, { method: "DELETE", headers: { origin: fixture.info.url } });
    expect(failed.status).toBe(500);
    expect((await api("GET", "/api/bots?messages=0")).groups.some((item: { id: string }) => item.id === group.id)).toBe(true);
    expect((await api("GET", `/api/threads/${group.threadId}/prompt-inspector`)).records).toEqual([]);
    rmdirSync(capture + ".tmp");
    await api("DELETE", `/api/groups/${group.id}`);
    expect(existsSync(join(fixture.info.dataDir, "prompt-inspector", group.threadId + ".json"))).toBe(false);
    const botCapture = join(fixture.info.dataDir, "prompt-inspector", bot.threadId + ".json");
    mkdirSync(botCapture + ".tmp");
    const botFailed = await fetch(`${fixture.info.url}/api/bots/${bot.id}`, { method: "DELETE", headers: { origin: fixture.info.url } });
    expect(botFailed.status).toBe(500);
    expect((await api("GET", "/api/bots?messages=0")).bots.some((item: { id: string }) => item.id === bot.id)).toBe(true);
    rmdirSync(botCapture + ".tmp");
    await api("DELETE", `/api/bots/${bot.id}`);
    expect(existsSync(join(fixture.info.dataDir, "prompt-inspector", bot.threadId + ".json"))).toBe(false);
    const response = await fetch(`${fixture.info.url}${endpoint}`); expect(response.status).toBe(404);
  } finally { await fixture.close(); }
}, 180_000);

it("cleans up its fixture when the pre-start callback fails", async () => {
  let dataDir = "";
  const failure = new Error("fixture setup failed");
  await expect(launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, dir => {
    dataDir = dir;
    throw failure;
  })).rejects.toBe(failure);
  expect(dataDir).not.toBe("");
  expect(existsSync(dataDir)).toBe(false);
});

it.each(["malformed journal", "unusable folder"])("keeps the chat server working when inspector startup has an %s", async (fault) => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, dataDir => {
    const folder = join(dataDir, "prompt-inspector");
    if (fault === "malformed journal") {
      mkdirSync(folder);
      writeFileSync(join(folder, ".pending-deletions.json"), "{invalid");
    } else writeFileSync(folder, "not a directory");
  });
  const api = fixtureApi(fixture.info.url), control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    const { bot } = await control("new-bot", "--name", "Startup fixture") as { bot: { id: string; threadId: string } };
    const saved = (await api("GET", "/api/bots?messages=0")).bots.find((item: { id: string }) => item.id === bot.id);
    bot.threadId = saved.tasks[0].threadId;
    const endpoint = `/api/threads/${bot.threadId}/prompt-inspector`;
    const unavailable = await fetch(fixture.info.url + endpoint);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json() as { error: string }).error).toMatch(/Prompt inspector unavailable/);
    await control("send", "--bot", bot.id, "--text", "Can you still reply?");
    await control("wait", "--bot", bot.id, "--timeout", "30");
    expect((await control("messages", "--bot", bot.id, "--limit", "10") as any).messages.some((message: any) => message.role === "bot")).toBe(true);
    const deletion = await fetch(`${fixture.info.url}/api/bots/${bot.id}`, { method: "DELETE", headers: { origin: fixture.info.url } });
    expect(deletion.status).toBe(500);
    expect((await api("GET", "/api/bots?messages=0")).bots.some((item: { id: string }) => item.id === bot.id)).toBe(true);
    if (fault === "malformed journal") expect(readFileSync(join(fixture.info.dataDir, "prompt-inspector", ".pending-deletions.json"), "utf8")).toBe("{invalid");
  } finally { await fixture.close(); }
}, 180_000);
