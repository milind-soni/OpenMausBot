// A room turn mounts the same agents server as a 1:1 turn, memory_update
// included — so its system prompt must give the same write guidance. Pinned
// against the real server because the two prompts are assembled inline in
// two different places, and only the assembled bytes prove they agree.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("gives a room turn the memory_update guidance, not the file-tools one", async () => {
  const fixture = await launchVerificationServer();
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { [key: string]: unknown };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const dump = () => {
    try {
      // SAFETY: the fake CLI writes exactly this shape; a missing or partial file reads as no dump yet
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt?: string; prompt?: unknown };
    } catch {
      return undefined;
    }
  };
  try {
    // SAFETY: control-omb returns the created bot record under `bot`
    const { bot: lead } = await runControlOmb(["new-bot", "--name", "Lead"], { env }) as { bot: { id: string } };
    // SAFETY: same shape as above
    const { bot: helper } = await runControlOmb(["new-bot", "--name", "Helper"], { env }) as { bot: { id: string } };
    // A 1:1 turn first: it is the reference the room turn must match.
    await runControlOmb(["send", "--bot", lead.id, "--text", "Remember that the fixture garden is watered on Mondays."], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const direct = dump()?.systemPrompt ?? "";
    expect(direct).toContain("Use memory_update for every change to MEMORY.md");
    expect(direct).not.toContain("update it with your file tools");

    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what day is the garden watered?" });
    await expect.poll(() => {
      const text = dump()?.systemPrompt ?? "";
      return text.includes("Reply to the conversation above as") || JSON.stringify(dump()?.prompt ?? "").includes("Reply to the conversation above as");
    }, { timeout: 30_000 }).toBe(true);
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const room = dump()?.systemPrompt ?? "";
    expect(room).toContain("Use memory_update for every change to MEMORY.md");
    expect(room).toContain("never direct file tools or whole-file overwrites");
    expect(room).not.toContain("update it with your file tools");
  } finally {
    await fixture.close();
  }
}, 120_000);
