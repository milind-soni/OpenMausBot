// A Chief of Staff turns skills on and off for several teammates in one skill_manage call, through the real server
// and its injected tools; only the provider's planning is scripted. One receipt card lists them all, and one Undo puts
// every one back. A bot that is not a Chief cannot do it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("turns named skills on and off across a Chief's teammates with one call, and one Undo puts them all back", async () => {
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
  const enabled = async (bot: { id: string }, name: string) =>
    ((await api("GET", `/api/bots/${bot.id}/skills`)).skills as any[]).find((skill) => skill.name === name)?.enabled;
  const run = async (bot: { id: string; activeTaskId: string }, text: string, steps: unknown[]) => {
    const before = providerTurns().length;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps, reply: `Done: ${text}` });
    writeFileSync(planPath, JSON.stringify(plans));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
    await expect.poll(() => providerTurns().length, { timeout: 25_000 }).toBe(before + 1);
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25")).status).toBe("settled");
    return providerTurns().slice(before)[0]!.evidence.filter((entry) => entry.step).map((entry) => entry.response.result.content[0].text as string);
  };
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: Does ${name} the way this person likes.\n---\n\n# ${name}\n\nFollow the person's steps.\n`;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await cli("new-bot", "--name", "Ada", "--section", "Operations")).bot;
    const bea = (await cli("new-bot", "--name", "Bea", "--section", "Operations")).bot;
    await api("PATCH", "/api/config", { features: { skillAuthoring: true } });

    await run(ada, "Save my research skill, and keep it off for now.", [
      { tool: "skill_manage", arguments: { action: "create", skill_md: skillMd("research"), source: "conversation" }, expectError: false },
      { tool: "skill_manage", arguments: { action: "disable", skill_name: "research" }, expectError: false },
    ]);
    await run(bea, "Save my lint skill.", [
      { tool: "skill_manage", arguments: { action: "create", skill_md: skillMd("lint"), source: "conversation" }, expectError: false },
    ]);
    expect([await enabled(ada, "research"), await enabled(bea, "lint")]).toEqual([false, true]);

    const [refused] = await run(ada, "Turn off Bea's lint skill.", [
      { tool: "skill_manage", arguments: { action: "teammates", changes: [{ bot_id: bea.id, skill_name: "lint", on: false }] }, expectError: true },
    ]);
    expect(refused).toContain("Only a Chief of Staff");
    expect(await enabled(bea, "lint")).toBe(true);

    const [changed] = await run(chief, "Turn on Ada's research skill and turn off Bea's lint skill.", [
      { tool: "skill_manage", arguments: { action: "teammates", changes: [
        { bot_id: ada.id, skill_name: "research", on: true },
        { bot_id: bea.id, skill_name: "lint", on: false },
      ] }, expectError: false },
    ]);
    expect(changed).not.toContain("confirmation card");
    expect([await enabled(ada, "research"), await enabled(bea, "lint")]).toEqual([true, false]);

    const receipts = ((await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=50`)).messages as any[]).filter((message) => message.card?.skillRequest);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0].card;
    expect(receipt).toMatchObject({ autoApplied: true, answered: "allow", skillRequest: { teammates: [
      { botId: ada.id, botName: "Ada", name: "research", action: "enable" },
      { botId: bea.id, botName: "Bea", name: "lint", action: "disable" },
    ] } });

    expect(await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: receipt.requestId })).toMatchObject({ ok: true, undone: true });
    expect([await enabled(ada, "research"), await enabled(bea, "lint")]).toEqual([false, true]);
  } finally {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
}, 120_000);
