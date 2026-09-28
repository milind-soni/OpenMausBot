// A bot in a room knows what it did in its 1:1 — and back. Pinned against
// the real server: the brief is assembled inline in two prompt builders, the
// disclosure chip lands in the room, and the finished turn leaves a line in
// the bot's daily log. Only the assembled bytes prove all three agree.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

/** Every memory/log/*.md under the fixture's data dir, with contents. */
function dailyLogs(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path, depth + 1);
      } else if (/[\\/]memory[\\/]log[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
        out.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root, 0);
  return out;
}

it("carries a bot's recent 1:1 work into a room turn, tells the room, logs the turn, and carries the room back", async () => {
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
    const { bot: lead } = await runControlOmb(["new-bot", "--name", "Lead"], { env }) as { bot: { id: string; threadId: string } };
    // SAFETY: same shape as above
    const { bot: helper } = await runControlOmb(["new-bot", "--name", "Helper"], { env }) as { bot: { id: string } };

    // The first 1:1 turn: nothing said anywhere else yet, so no brief.
    await runControlOmb(["send", "--bot", lead.id, "--text", "Please reconcile the September invoices."], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const first = dump()?.systemPrompt ?? "";
    expect(first).not.toContain("Your recent work");

    // The finished turn left one line in Lead's daily log, sourced to the chat.
    await expect.poll(() => dailyLogs(fixture.info.dataDir).some((log) => log.path.includes(lead.id) && /from (chat|thread) /.test(log.text)), { timeout: 10_000 }).toBe(true);
    const logged = dailyLogs(fixture.info.dataDir).find((log) => log.path.includes(lead.id))!;
    expect(logged.text).toMatch(/^- \d{2}:\d{2} · from (chat|thread) .+ · .+/m);

    // A room turn: the brief names what Lead said in the 1:1, and the room is told.
    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Standup", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string; threadId: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what did you do today?" });
    await expect.poll(() => {
      const text = dump()?.systemPrompt ?? "";
      return text.includes("Reply to the conversation above as") || JSON.stringify(dump()?.prompt ?? "").includes("Reply to the conversation above as");
    }, { timeout: 30_000 }).toBe(true);
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const room = dump()?.systemPrompt ?? "";
    expect(room).toContain("Your recent work");
    expect(room).toMatch(/- today \d{2}:\d{2} · 1:1 with User · (?:"[^"]*" · )?you said: "/);
    const exported = await api("GET", `/api/threads/${group.threadId}/export?format=json`) as { messages?: Array<{ kind?: string; tool?: { name?: string } }> };
    const chips = (exported.messages ?? []).filter((message) => message.kind === "activity" && /recent-work brief/.test(message.tool?.name ?? ""));
    expect(chips).toHaveLength(1);
    expect(chips[0]!.tool!.name).toBe("Lead's recent-work brief covers 1 private chat with you");

    // Back the other way: Lead's next 1:1 turn knows what it said in the room.
    await runControlOmb(["send", "--bot", lead.id, "--text", "And now?"], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const second = dump()?.systemPrompt ?? "";
    expect(second).toContain("Your recent work");
    expect(second).toContain('room "Standup" · you said: "');
    // the room turn was logged too, sourced to the room
    expect(dailyLogs(fixture.info.dataDir).find((log) => log.path.includes(lead.id))!.text).toContain('from room "Standup"');
  } finally {
    await fixture.close();
  }
}, 180_000);
