import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("offers Haiku 5.5 and sends a saved selection to the Claude CLI", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_VERSION: "2.1.296" });
  const selection = { instanceId: "claude", model: "claude-haiku-5-5" };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  try {
    const response = await fetch(`${fixture.info.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Haiku fixture", modelSelection: selection, requireAvailableModel: true }),
    });
    const created = await response.json() as { bot: { id: string; threadId: string; modelSelection: unknown } };
    expect(response.status, JSON.stringify(created)).toBe(201);
    expect(created.bot.modelSelection).toEqual(selection);
    const { bot } = created;
    await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Reply with a greeting."]);
    expect(await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"]))
      .toMatchObject({ status: "settled" });
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[] };
    expect(dump.argv[dump.argv.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
  } finally {
    await fixture.close();
  }
}, 45_000);
