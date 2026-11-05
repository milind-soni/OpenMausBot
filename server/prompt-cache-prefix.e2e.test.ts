// Providers cache a prompt from its start: tools, then the system prompt. Anything in there that differs between two threads
// of one bot makes each new thread write the rest again at the cache-write rate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("launches two threads of one bot with the same system prompt, each with its own folder in its first message", async () => {
  const fixture = await launchVerificationServer();
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return await response.json() as any;
  };
  // systemPromptFile is the file the CLI is launched with; the fixture's systemPrompt adds what the first message carries.
  const turn = async (botId: string, threadId: string) => {
    await control(["send", "--bot", botId, "--task", threadId, "--text", "hi"]);
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    return { launched: dump.systemPromptFile as string, message: JSON.stringify(dump.prompt) };
  };
  // A path as the first message holds it: JSON in the prompt, inside the JSON of the message.
  const folder = (botId: string, threadId: string) => JSON.stringify(JSON.stringify(join(fixture.info.dataDir, "task-workspaces", botId, threadId))).slice(1, -1);
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Garden helper" });
    const { task: second } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second", select: false });
    const first = await turn(bot.id, bot.threadId);
    const other = await turn(bot.id, second.threadId);
    expect(first.launched).toContain("You are Garden helper");
    expect(other.launched).toBe(first.launched);
    expect(first.launched).not.toContain(bot.threadId);
    expect(first.message).toContain(folder(bot.id, bot.threadId));
    expect(other.message).toContain(folder(bot.id, second.threadId));
  } finally {
    await fixture.close();
  }
}, 120_000);
