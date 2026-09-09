import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("dispatches setup and canonical standing instructions through the real isolated app", async () => {
  const fixture = await launchVerificationServer();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Setup fixture"], { env }) as any;
    const turn = async (text: string) => {
      await runControlOmb(["send", "--bot", bot.id, "--text", text], { env });
      await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env });
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    };
    const setup = await turn("/setup Help me track garden watering");
    expect(setup.systemPrompt).toContain("Your job this conversation is to set yourself up");
    expect(setup.systemPrompt).toContain("propose_profile");
    expect(JSON.stringify(setup.prompt)).toContain("Set yourself up for this job: Help me track garden watering");

    await api("PATCH", `/api/bots/${bot.id}`, { description: "Garden helper", soul: "Only water the fixture garden after approval." });
    writeFileSync(join(fixture.info.dataDir, "bots", bot.id, "SOUL.md"), "UNAPPROVED MIRROR INSTRUCTIONS");
    const configured = await turn("What is your job?");
    expect(configured.systemPrompt).toContain("Only water the fixture garden after approval.");
    expect(configured.systemPrompt).not.toContain("UNAPPROVED MIRROR INSTRUCTIONS");
    expect(configured.systemPrompt).not.toContain("Your job this conversation is to set yourself up");
    const drift = await api("GET", `/api/bots/${bot.id}/soul`);
    expect(drift.drift).toBe(true);
    expect(drift.fileText).toBe("UNAPPROVED MIRROR INSTRUCTIONS");
    expect((await api("GET", `/api/bots/${bot.id}/history`)).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "soul" }),
    ]));
    const messages = await runControlOmb(["messages", "--bot", bot.id, "--limit", "10"], { env });
    expect(JSON.stringify(messages)).toContain("hello from fake claude");
  } finally {
    await fixture.close();
  }
}, 90_000);
