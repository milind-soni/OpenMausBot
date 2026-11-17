// A room set to several turns per member walks its members that many times for one message, and only the last
// turn's prompt tells a member it is its final turn, on an isolated fixture with the scripted engine.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("gives each member three turns in order and tells it the last one is final", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const first = (await cli("new-bot", "--name", "First", "--section", "A")).bot;
    const second = (await cli("new-bot", "--name", "Second", "--section", "A")).bot;
    const { group: room } = await api("POST", "/api/groups", {
      name: "Rounds", memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect((await api("PATCH", `/api/groups/${room.id}`, { turnsPerMember: 3 })).group.turnsPerMember).toBe(3);
    const planPath = join(session.info.dataDir, "room-plan.json");
    const turns = (name: string) => ({ turns: [1, 2, 3].map(n => ({ reply: `${name} turn ${n}` })) });
    writeFileSync(planPath, JSON.stringify({ [first.id]: turns("First"), [second.id]: turns("Second") }));

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Plan the launch together" });
    await expect.poll(() => {
      try { return readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").length; } catch { return 0; }
    }, { timeout: 60_000 }).toBe(6);
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");

    const evidence = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const final = "This is your final turn in this exchange (turn 3 of 3).";
    expect(evidence.map((turn: any) => [turn.botId === first.id ? "First" : "Second", turn.turnIndex, JSON.stringify(turn.prompt).includes(final)])).toEqual([
      ["First", 0, false], ["Second", 0, false],
      ["First", 1, false], ["Second", 1, false],
      ["First", 2, true], ["Second", 2, true],
    ]);
    const thread = await api("POST", `/api/groups/${room.id}/tasks/${room.threadId}`);
    const replies = thread.group.messages.filter((message: any) => message.role === "bot" && message.kind !== "activity" && !message.text.startsWith("[digest]")).map((message: any) => message.text);
    expect(replies).toEqual(["First turn 1", "Second turn 1", "First turn 2", "Second turn 2", "First turn 3", "Second turn 3"]);
  } finally {
    await session.close();
  }
}, 120_000);
