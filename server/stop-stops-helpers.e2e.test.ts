// Stop means stop, end to end on the scripted engine: the person's Stop in the chat that handed work out also stops the
// teammates working for that request, not only the ones that had not started. Modelled on a real day, when a stop left
// hand-offs running and their results kept arriving for minutes after it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("stops the teammates working for a request when the person stops the chat that asked, with no late results", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const post = (await cli("new-bot", "--name", "Post")).bot;
    const cos = (await cli("new-bot", "--name", "Chief of staff")).bot;
    const research = (await cli("new-bot", "--name", "Research")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const started = join(session.info.dataDir, "helpers-started");
    writeFileSync(planPath, JSON.stringify({
      [post.id]: { script: [{ key: "S1", match: ["S1-JOB"], steps: [{ arguments: { bot_ids: [cos.id, research.id], message: "S1-ASK: find the mailbox settings" } }], reply: "S1: asked two teammates." }] },
      [cos.id]: { script: [{ key: "S1-ASK", match: ["S1-ASK"], readyFile: started, delayMs: 8_000, reply: "S1-ASK late: the settings are in the old notes." }] },
      [research.id]: { script: [{ key: "S1-ASK", match: ["S1-ASK"], delayMs: 8_000, reply: "S1-ASK late: the host is imap.example.test." }] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
    const busy = async (id: string) => ((await api("/api/bots?messages=0", undefined, "GET")).bots as any[]).find((bot) => bot.id === id)?.busy;
    const helpers = () => readHandoffs(session.info.dataDir).filter((node) => node.parentId);

    await cli("send", "--bot", post.id, "--task", post.activeTaskId, "--text", "S1-JOB: fetch my mail");
    await expect.poll(() => existsSync(started) && helpers().every((node) => node.status === "running"), { timeout: 20_000 }).toBe(true);
    expect(helpers()).toHaveLength(2);

    await cli("interrupt", "--bot", post.id, "--task", post.activeTaskId);
    await expect.poll(() => helpers().map((node) => node.status), { timeout: 5_000 }).toEqual(["cancelled", "cancelled"]);
    await expect.poll(async () => (await busy(cos.id)) || (await busy(research.id)), { timeout: 10_000 }).toBeFalsy();
    expect((await messages(post.activeTaskId)).some((row) => /still working; open to stop it too/.test(row.tool?.name ?? "")), "no pill: nothing was left running").toBe(false);

    // Past the moment the helpers would have answered: nothing lands, and the asking chat never resumes.
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    for (const node of helpers()) expect((await messages(node.threadId)).some((row) => /late:/.test(row.text ?? ""))).toBe(false);
    expect(evidence().filter((turn) => turn.botId === post.id).map((turn) => turn.planKey), "the asking chat never resumed").toEqual(["S1"]);
    expect(helpers().map((node) => node.status)).toEqual(["cancelled", "cancelled"]);
  } finally {
    await session.close();
  }
}, 90_000);
