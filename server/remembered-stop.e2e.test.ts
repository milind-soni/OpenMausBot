// A stop the person made is remembered, end to end on the scripted engine. The person stops a teammate working on their
// request; the bot that asked hears it stopped and tries to hand the same work back: refused, until the person asks
// again. Then it goes through as usual.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const SETTLED = "Your downstream room requests have settled.";

it("keeps a teammate the person stopped from getting the same request back, until the person asks again", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const post = (await cli("new-bot", "--name", "Post")).bot;
    const research = (await cli("new-bot", "--name", "Research")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const started = join(session.info.dataDir, "research-started");
    const again = (expectError: boolean) => ({ arguments: { bot_ids: [research.id], message: "R1-AGAIN: please still look up the mail host" }, expectError });
    writeFileSync(planPath, JSON.stringify({
      [post.id]: { script: [
        { key: "R1", match: ["R1-JOB"], steps: [{ arguments: { bot_ids: [research.id], message: "R1-ASK: look up the mail host" } }], reply: "R1: asked Research." },
        { key: "R1-BACK", match: [SETTLED, "R1-JOB"], steps: [again(true)], reply: "R1-BACK: Research was stopped; say if you want it looked up." },
        { key: "R2", match: ["R1-JOB"], steps: [again(false)], reply: "R2: asked Research again." },
        { key: "R2-DONE", match: [SETTLED, "R1-JOB"], reply: "R2-DONE: the host is imap.example.test." },
      ] },
      [research.id]: { script: [
        { key: "R1-ASK", match: ["R1-ASK"], readyFile: started, delayMs: 8_000, reply: "R1-ASK late: imap.example.test" },
        { key: "R2-WORK", match: ["R1-AGAIN"], reply: "R2-WORK: imap.example.test" },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const said = async (threadId: string, text: string) => ((await api(`/api/threads/${threadId}/messages`)).messages as any[]).some((row) => row.text === text);
    const step = (key: string) => evidence().find((turn) => turn.planKey === key)?.evidence.find((entry: any) => entry.step)?.response.result;

    await cli("send", "--bot", post.id, "--task", post.activeTaskId, "--text", "R1-JOB: find out where my mail lives");
    await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true);
    const work = readHandoffs(session.info.dataDir).find((node) => node.parentId)!;
    // The person stops Research's work in its own thread.
    await cli("interrupt", "--bot", research.id, "--task", work.threadId);
    await expect.poll(() => said(post.activeTaskId, "R1-BACK: Research was stopped; say if you want it looked up."), { timeout: 20_000 }).toBe(true);
    expect(step("R1-BACK").isError).toBe(true);
    expect(JSON.stringify(step("R1-BACK"))).toContain("The person stopped this teammate's work on this request.");

    // The person asks again, in the same words: the same hand-off goes through.
    await cli("send", "--bot", post.id, "--task", post.activeTaskId, "--text", "R1-JOB: find out where my mail lives");
    await expect.poll(() => said(post.activeTaskId, "R2-DONE: the host is imap.example.test."), { timeout: 20_000 }).toBe(true);
    expect(evidence().filter((turn) => turn.botId === research.id).map((turn) => turn.planKey)).toContain("R2-WORK");
  } finally {
    await session.close();
  }
}, 90_000);
