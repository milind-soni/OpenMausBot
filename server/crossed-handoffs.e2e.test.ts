// Two bots that ask each other at once, end to end on the scripted engine (docs/runtime-contract.md §2). Modelled on a real
// day: the mail bot asked the chief of staff for yesterday's mailbox details; before that was answered, the person told the
// chief of staff in its own chat that mail had worked yesterday, and the chief of staff asked the mail bot why it failed.
// Each conversation answers its own request: the chief of staff's question from its own chat goes through while the mail
// bot waits on it, and both get their answers. A request from or into the conversation that holds the waiting one is still
// refused (server/runtime-coordinator.test.ts).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const SETTLED = "Your downstream room requests have settled.";

it("lets the chief of staff ask the mail bot from its own chat while the mail bot waits on it, and both get their answers", async () => {
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
        { key: "C1-WORK", match: ["C1-ASK"], reply: "C1-WORK: the mail server refuses the saved sign-in since this morning." },
      ] },
      [cos.id]: { script: [
        { key: "P1-ASK", match: ["P1-ASK"], readyFile: ready, gateFile: gate, reply: "P1-ASK: no mailbox details are stored here." },
        { key: "C1", match: ["C1-JOB"], steps: [{ arguments: { bot_ids: [post.id], message: "C1-ASK: why can't you fetch mail?" } }], reply: "C1: asked Post." },
        { key: "C1-DONE", match: [SETTLED, "C1-JOB"], reply: "C1-DONE: the mail server refuses the saved sign-in." },
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
    await expect.poll(() => said(cos.activeTaskId, "C1-DONE: the mail server refuses the saved sign-in."), { timeout: 20_000 }).toBe(true);
    const sent = evidence().find((turn) => turn.planKey === "C1").evidence.find((entry: any) => entry.step).response.result;
    expect(sent.isError, JSON.stringify(sent)).not.toBe(true);
    expect(keys(post.id), "the mail bot answered the chief of staff while it still waited on its own question").toEqual(["P1", "C1-WORK"]);

    writeFileSync(gate, "answer");
    await expect.poll(() => said(post.activeTaskId, "P1-DONE: nothing stored, so I need the mailbox password from you."), { timeout: 20_000 }).toBe(true);
    expect(keys(post.id)).toEqual(["P1", "C1-WORK", "P1-DONE"]);
    expect(keys(cos.id).sort(), "the chief of staff answered the person and the mail bot").toEqual(["C1", "C1-DONE", "P1-ASK"]);
    expect(readHandoffs(session.info.dataDir).filter((node) => node.parentId).map((node) => node.status)).toEqual(["completed", "completed"]);
  } finally {
    await session.close();
  }
}, 90_000);
