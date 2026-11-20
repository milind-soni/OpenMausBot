import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";

it("a direct turn's setup shows in the diagnostics: its total over the hour and on the turn's own line", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok).toBe(true);
    return response.json() as Promise<Record<string, never>>;
  };
  try {
    const { bots } = await api("GET", "/api/bots") as unknown as { bots: Array<{ id: string; threadId: string }> };
    const bot = bots[0]!;
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Say hi", threadId: bot.threadId });
    const lines = async () => String((await api("GET", "/api/diagnostics/performance") as unknown as { text: string }).text).split("\n");
    const finished = (line: string) => line.includes(`thread ${bot.threadId}`) && line.includes("queue ");
    await expect.poll(async () => (await lines()).some(finished), { timeout: 30_000 }).toBe(true);
    const text = await lines();
    expect(text.filter((line) => line.includes("Turn setup, inside queue")).every((line) => /: total p50 \d/.test(line))).toBe(true);
    expect(text.filter((line) => line.includes("Turn setup, inside queue"))).toHaveLength(2);
    expect(text.find(finished)).toMatch(/queue \S+ \(dispatch\).*, setup \d/);
  } finally { await fixture.close(); }
}, 90_000);
