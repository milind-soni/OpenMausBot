// A person's room message: the bot its first answer @mentions may save a skill once, a bot only a later answer names
// may not. On an isolated fixture with the scripted engine calling skill_manage through the real agents MCP server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const skill = (name: string) => `---\nname: ${name}\ndescription: Cuts a video the way this person does.\n---\n\n# ${name}\n\nTrim, then caption.\n`;

it("lets the bot a person's first answer names save a skill, and not one a later answer names", async () => {
  const session = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const planPath = join(dataDir, "room-plan.json");
  const turns = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const skills = async (bot: { id: string }) => ((await api("GET", `/api/bots/${bot.id}/skills`)).skills as any[]).map((one) => one.name);
  try {
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "A")).bot;
    const video = (await cli("new-bot", "--name", "Video", "--section", "A")).bot;
    const scout = (await cli("new-bot", "--name", "Scout", "--section", "A")).bot;
    await api("PATCH", "/api/config", { features: { skillAuthoring: true } });
    const { group: room } = await api("POST", "/api/groups", {
      name: "Edit bay", memberIds: [lead.id, video.id, scout.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    const create = (name: string, expectError: boolean) => ({ tool: "skill_manage", arguments: { action: "create", skill_md: skill(name), source: "conversation" }, expectError });
    writeFileSync(planPath, JSON.stringify({
      [lead.id]: { turns: [{ reply: "@Video please save the cut steps as a skill." }] },
      [video.id]: { turns: [{ steps: [create("video-cut", false)], reply: "Saved. @Scout save yours too." }] },
      [scout.id]: { turns: [{ steps: [create("scout-cut", true)], reply: "I can't save skills here." }] },
    }));

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Ask Video to save how we cut videos." });
    await expect.poll(() => turns().length, { timeout: 60_000 }).toBe(3);
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");

    expect(await skills(video)).toContain("video-cut");
    expect(await skills(scout)).not.toContain("scout-cut");
    expect(turns().map((turn: any) => turn.botId)).toEqual([lead.id, video.id, scout.id]);
  } finally {
    await session.close();
  }
}, 120_000);
