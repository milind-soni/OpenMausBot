// The TypeScript SDK against a real MausBot server with the fake engine: the card's own address in, the bot's reply out.
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../../scripts/control-omb.ts";
import { hostTimeout } from "../../../server/testing/host-timeout.ts";
import { AuthenticationError, Bot } from "../src/index.js";

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function botApiOn() {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" });
  const { url } = fixture.info;
  const bot = (await runControlOmb(["new-bot", "--name", "Scout", "--url", url]) as any).bot;
  const response = await fetch(`${url}/api/bots/${bot.id}/bot-api`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ enabled: true }) });
  const on = await response.json() as { url: string; key: string };
  expect(on.key).toMatch(/^bak_/);
  return { endpoint: on.url, key: on.key };
}

it("asks a bot on a real server through the card's own address and gets its reply", async () => {
  const { endpoint, key } = await botApiOn();
  const answer = await new Bot({ endpoint, key }).ask("Hello");
  expect(answer).toMatchObject({ status: "replied", thread: expect.any(String) });
  expect((answer as { reply: string }).reply.length).toBeGreaterThan(0);
}, hostTimeout(180_000));

it("raises AuthenticationError for a wrong key on a real server", async () => {
  const { endpoint } = await botApiOn();
  await expect(new Bot({ endpoint, key: "wrong" }).ask("Hello")).rejects.toBeInstanceOf(AuthenticationError);
}, hostTimeout(180_000));
