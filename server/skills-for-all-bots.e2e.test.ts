// A Chief puts a skill on all of the person's bots in one skill_manage call, through the real server and its injected
// tools; only the provider's planning is scripted. A bot made afterwards has it too, and one delete takes it off all.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("puts a skill on every bot of the person's with one tool call, and takes it off them all with one more", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: unknown[] }> = {};
  const providerTurns = (): Array<{ botId: string; evidence: Array<{ step?: unknown; response: any }> }> => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const shared = async (bot: { id: string }) => ((await api("GET", `/api/bots/${bot.id}/skills`)).skills as any[]).filter((skill) => skill.name === "client-onboarding");
  const run = async (bot: { id: string; activeTaskId: string }, text: string, steps: unknown[]) => {
    const before = providerTurns().length;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps, reply: `Done: ${text}` });
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => providerTurns().length, { timeout: 25_000 }).toBe(before + 1);
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25")).status).toBe("settled");
    return providerTurns().slice(before)[0]!.evidence.filter((entry) => entry.step).map((entry) => entry.response.result.content[0].text as string);
  };
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    const writer = (await cli("new-bot", "--name", "Wren", "--section", "Writing")).bot;
    await api("PATCH", "/api/config", { features: { skillAuthoring: true } });
    const skillMd = "---\nname: client-onboarding\ndescription: Sets up a new client the way this person does.\n---\n\n# Client onboarding\n\nMake the folder, then the intake sheet.\n";

    const [created] = await run(chief, "Put my client-onboarding skill on all my bots.", [
      { tool: "skill_manage", arguments: { action: "create", all_bots: true, skill_md: skillMd, source: "conversation" }, expectError: false },
    ]);
    expect(created).toContain("is on all your bots");
    const later = (await cli("new-bot", "--name", "Lark")).bot;
    for (const bot of [chief, writer, later]) expect(await shared(bot)).toEqual([expect.objectContaining({ enabled: true, allBots: true })]);
    const receipt = ((await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=50`)).messages as any[]).find((message) => message.card?.skillRequest);
    expect(receipt.card).toMatchObject({ autoApplied: true, skillRequest: { allBots: true, action: "create", name: "client-onboarding" } });

    const listed = await run(writer, "Which skills do you have?", [{ tool: "skills_list", arguments: {}, expectError: false }]);
    expect(listed[0]).toContain("client-onboarding (enabled, on all your bots: update/delete changes all)");

    const [deleted] = await run(writer, "Remove client-onboarding from all my bots.", [
      { tool: "skill_manage", arguments: { action: "delete", skill_name: "client-onboarding" }, expectError: false },
    ]);
    expect(deleted).toContain("removed from all your bots");
    for (const bot of [chief, writer, later]) expect(await shared(bot)).toEqual([]);
  } finally {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
}, 120_000);
