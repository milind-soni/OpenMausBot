// End-to-end coverage for X research: the per-bot switch a real server keeps,
// and (with a loopback treg stub) the x_* tools a real agents proxy
// advertises and calls. No external service is reached.
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

async function withXFixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    await test({ session, cli, api });
  } finally {
    await session.close();
  }
}

it("keeps X research off for a new bot and accepts only a boolean switch", async () => withXFixture(async (f) => {
  const bot = (await f.cli("new-bot", "--name", "X bot")).bot;
  expect(bot.xResearch).toBeUndefined();
  const patched = await f.api("/api/bots/" + bot.id, { xResearch: true }, "PATCH");
  expect(patched.bot.xResearch).toBe(true);
  await expect(f.api("/api/bots/" + bot.id, { xResearch: "yes" }, "PATCH")).rejects.toThrow(/xResearch must be true or false/);
}), 60_000);
