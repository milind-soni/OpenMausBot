import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("a bot may select 50 MCP servers and not 51", async () => {
  const session = await launchVerificationServer({ ...process.env });
  try {
    const created = await runControlOmb(["new-bot", "--name", "Limit fixture"], { env: { OPENMAUSBOT_URL: session.info.url } }) as { bot: { id: string } };
    const select = async (count: number) => {
      const response = await fetch(`${session.info.url}/api/bots/${created.bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpServers: Array.from({ length: count }, (_, i) => `s${i}`) }),
      });
      return { status: response.status, body: await response.json() as { error?: string } };
    };
    expect((await select(50)).status).toBe(200);
    const over = await select(51);
    expect(over.status).toBe(400);
    expect(over.body.error).toBe("Select at most 50 MCP servers.");
  } finally {
    await session.close();
  }
}, 90_000);
