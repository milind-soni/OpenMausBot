// Two bots that ask each other at once, end to end on the scripted engine (docs/runtime-contract.md §2). Modelled on a real
// day: the mail bot asked the chief of staff for yesterday's mailbox details; before that was answered, the person told the
// chief of staff in its own chat that mail had worked yesterday, and the chief of staff asked the mail bot why it failed.
// Both then waited on each other, both worked the same problem in two places, and each came back with its own plan.
// After: the second request is refused at once, naming the request it would answer, so the chief of staff answers the
// person itself and the mail bot's question still gets its answer. Once that answer is in, the same hand-off is ordinary.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const SETTLED = "Your downstream room requests have settled.";

it("refuses a request back to a bot that is waiting on you, and the same hand-off once it has its answer", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const post = (await cli("new-bot", "--name", "Post")).bot;
    const cos = (await cli("new-bot", "--name", "Chief of staff")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "cos-answers");
    const ready = join(session.info.dataDir, "cos-asked");
    writeFileSync(planPath, JSON.stringify({
      [post.id]: { script: [
        { key: "P1", match: ["P1-JOB"], steps: [{ arguments: { bot_ids: [cos.id], message: "P1-ASK: do you still have yesterday's mailbox details?", consult: true } }],
          reply: "P1: asked the chief of staff." },
        { key: "P1-DONE", match: [SETTLED, "P1-JOB"], reply: "P1-DONE: nothing stored, so I need the mailbox password from you." },
        { key: "C2-WORK", match: ["C2-ASK"], reply: "C2-WORK: the server answers on port 993." },
      ] },
      [cos.id]: { script: [
        { key: "P1-ASK", match: ["P1-ASK"], readyFile: ready, gateFile: gate, reply: "P1-ASK: no mailbox details are stored here." },
        { key: "C1", match: ["C1-JOB"], steps: [{ arguments: { bot_ids: [post.id], message: "C1-ASK: why can't you fetch mail?" }, expectError: true }],
          reply: "C1: Post is already asking me about this; I'll answer it there." },
        { key: "C2", match: ["C2-JOB"], steps: [{ arguments: { bot_ids: [post.id], message: "C2-ASK: which port does the mail server use?" } }], reply: "C2: asked Post." },
        { key: "C2-DONE", match: [SETTLED, "C2-JOB"], reply: "C2-DONE: port 993." },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const keys = (botId: string) => evidence().filter((turn) => turn.botId === botId).map((turn) => turn.planKey);
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
    const said = async (threadId: string, text: string) => (await messages(threadId)).some((row) => row.text === text);

    await cli("send", "--bot", post.id, "--task", post.activeTaskId, "--text", "P1-JOB: fetch my mail through the Mac mini");
    await expect.poll(() => existsSync(ready), { timeout: 20_000 }).toBe(true);
    // The chief of staff is answering the mail bot in its work thread when the person writes to it in its own chat.
    await cli("send", "--bot", cos.id, "--task", cos.activeTaskId, "--text", "C1-JOB: mail worked yesterday, find out why it fails");
    await expect.poll(() => said(cos.activeTaskId, "C1: Post is already asking me about this; I'll answer it there."), { timeout: 20_000 }).toBe(true);
    const refusal = evidence().find((turn) => turn.planKey === "C1").evidence.find((entry: any) => entry.step).response.result;
    expect(refusal.isError).toBe(true);
    expect(JSON.stringify(refusal)).toContain("@Post is already waiting on you: it handed you a request");
    expect(JSON.stringify(refusal), "the waiting request's words stay in its own thread").not.toContain("P1-ASK");

    writeFileSync(gate, "answer");
    await expect.poll(() => said(post.activeTaskId, "P1-DONE: nothing stored, so I need the mailbox password from you."), { timeout: 20_000 }).toBe(true);
    expect(keys(post.id), "the mail bot asked once and heard back once; nothing was handed back to it").toEqual(["P1", "P1-DONE"]);
    expect(keys(cos.id).sort(), "the chief of staff answered the person and the mail bot, one turn each").toEqual(["C1", "P1-ASK"]);
    expect(readHandoffs(session.info.dataDir).filter((node) => node.parentId)).toHaveLength(1);

    // A legitimate hand-off the other way, once nothing waits on it any more, goes through as before.
    await cli("send", "--bot", cos.id, "--task", cos.activeTaskId, "--text", "C2-JOB: ask Post for the mail server's port");
    await expect.poll(() => said(cos.activeTaskId, "C2-DONE: port 993."), { timeout: 20_000 }).toBe(true);
    expect(keys(post.id)).toEqual(["P1", "P1-DONE", "C2-WORK"]);
    expect(readHandoffs(session.info.dataDir).filter((node) => node.parentId).map((node) => node.status)).toEqual(["completed", "completed"]);
  } finally {
    await session.close();
  }
}, 90_000);
