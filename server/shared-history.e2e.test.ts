import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

it("sends exact cross-conversation records through actual private and room dispatch", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.270" }, undefined, undefined, undefined, undefined, { scripted: true });
  const api = (path: string, body?: unknown, method = "POST") => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, fixture.info.url) as Promise<any>;
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const dump = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "fake-claude-dump.json"), "utf8"));
  const prompt = () => String(dump().prompt.message.content);
  const shared = () => prompt().split("</other_conversations>")[0];
  try {
    const { bot } = await control("new-bot", "--name", "Continuity fixture");
    const { bot: other } = await control("new-bot", "--name", "Unrelated fixture");
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "Acknowledged." }, [other.id]: { reply: "Private reply." } }));
    const send = async (id: string, task: string, text: string) => {
      await control("send", "--bot", id, "--task", task, "--text", text);
      expect((await control("wait", "--bot", id, "--task", task, "--timeout", "30")).status).toBe("settled");
    };
    await send(other.id, other.activeTaskId, "UNRELATED_PRIVATE_83B");
    await send(bot.id, bot.activeTaskId, "PRIVATE_REQUIREMENT_19A");
    const { group } = await api("/api/groups", { name: "Continuity room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    await control("send-channel", "--channel", group.id, "--task", group.threadId, "--text", "HANDOFF_27C: continue the work in the private chat.");
    expect((await control("wait", "--channel", group.id, "--task", group.threadId, "--timeout", "30")).status).toBe("settled");
    expect(shared()).toContain("PRIVATE_REQUIREMENT_19A");
    expect(shared()).not.toContain("UNRELATED_PRIVATE_83B");
    const messages = (await api(`/api/threads/${group.threadId}/messages`, undefined, "GET")).messages;
    expect(messages.some((message: any) => message.kind === "activity" && /private|conversation|recall/i.test(message.tool?.name ?? ""))).toBe(true);
    await send(bot.id, bot.activeTaskId, "Continue.");
    expect(shared()).toContain("HANDOFF_27C: continue the work in the private chat.");
    expect(shared()).not.toContain("PRIVATE_REQUIREMENT_19A");
    expect(shared()).not.toContain("UNRELATED_PRIVATE_83B");
    await api(`/api/groups/${group.id}`, undefined, "DELETE");
    await send(bot.id, bot.activeTaskId, "Check the next task.");
    expect(prompt()).not.toContain("HANDOFF_27C");
  } finally { await fixture.close(); }
}, 90_000);
