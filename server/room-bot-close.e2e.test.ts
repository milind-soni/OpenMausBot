// A bot closes the room thread it answers in with its final reply, on an isolated fixture with the scripted engine: the
// room turn's instructions ask it to, close_thread with no thread_id closes that thread once the turn ends (its own reply
// and digest do not open it again), the thread stays unread until read, and the person's next line opens it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { GroupTask } from "../shared/wire.ts";

it("closes its room thread with its final reply, and a person's next line opens it again", async () => {
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
    const writer = (await cli("new-bot", "--name", "Writer", "--section", "A")).bot;
    const { group: room } = await api("POST", "/api/groups", {
      name: "Docs", memberIds: [writer.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: writer.id } },
    });
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ [writer.id]: { script: [
      { key: "W1", match: ["Fix the typo"], steps: [{ tool: "close_thread", arguments: {} }], reply: "Fixed the typo." },
      { key: "W2", match: ["one more"], reply: "Done as well." },
    ] } }));
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const task = async (): Promise<GroupTask> => ((await api("GET", "/api/bots")).groups as Array<{ id: string; tasks: GroupTask[] }>)
      .find((group) => group.id === room.id)!.tasks.find((candidate) => candidate.threadId === room.threadId)!;

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Fix the typo in the README", threadId: room.threadId });
    await expect.poll(() => evidence().some((turn) => turn.planKey === "W1"), { timeout: 60_000 }).toBe(true);
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    const turn = evidence().find((record) => record.planKey === "W1");
    expect(turn.system).toContain("When the work in this thread is finished, close it with your final reply");
    // Splitting work and the work view are a Team Cloud's: no board tools here, so no line about them.
    expect(turn.system).not.toMatch(/board_add|board_list/);
    expect((turn.evidence[0].result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>).find((tool) => tool.name === "close_thread")?.inputSchema.required ?? []).not.toContain("thread_id");
    const closeAnswer = turn.evidence.at(-1).response.result;
    expect(closeAnswer.isError ?? false, JSON.stringify(closeAnswer)).toBe(false);
    expect(closeAnswer.content[0].text).toContain("closes when this reply ends");

    await expect.poll(async () => (await task()).closedBy, { timeout: 15_000 }).toEqual({ kind: "bot", id: writer.id, name: "Writer" });
    const closed = await task();
    expect(closed).toMatchObject({ closedAt: expect.any(Number), unread: true });
    const transcript = (await api("GET", `/api/threads/${room.threadId}/messages`)).messages as Array<{ role: string; text?: string }>;
    expect(transcript.some((message) => message.role === "bot" && message.text === "Fixed the typo.")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await task()).closedAt).toBe(closed.closedAt);

    await api("POST", `/api/groups/${room.id}/messages`, { text: "And one more fix, please", threadId: room.threadId });
    await expect.poll(async () => (await task()).closedAt, { timeout: 15_000 }).toBeUndefined();
    await expect.poll(() => evidence().some((record) => record.planKey === "W2"), { timeout: 60_000 }).toBe(true);
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    expect(await task()).not.toHaveProperty("closedBy");
  } finally {
    await session.close();
  }
}, 180_000);
