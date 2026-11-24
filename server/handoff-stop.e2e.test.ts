// The person stops one teammate's work on their request, end to end on the scripted engine. Other work waiting in that
// teammate's thread still runs to the end, and another request in the same words, open in another conversation, can still
// hand the teammate work afterwards: the stop holds only for the request it stopped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const SETTLED = "Your downstream room requests have settled.";
const LINE = "JOB: find out where my mail lives";

it("stops one hand-off and leaves the next request in that teammate's thread going", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const post = (path: string) => request(path, { method: "POST", body: "{}" }, session.info.url)
    .then((body: any) => ({ status: 200, body }), (error: { status?: number }) => ({ status: error.status }));
  const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
  try {
    const asker = (await cli("new-bot", "--name", "Post")).bot;
    const research = (await cli("new-bot", "--name", "Research")).bot;
    const { task: second } = await request(`/api/bots/${asker.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Second chat" }) }, session.info.url) as any;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const started = join(session.info.dataDir, "research-started");
    const ask = (message: string, { expectError = false, rework = false } = {}) => ({ arguments: { bot_ids: [research.id], message, thread: "standing", ...(rework ? { rework } : {}) }, expectError });
    writeFileSync(planPath, JSON.stringify({
      [asker.id]: { script: [
        { key: "P1", match: [LINE], steps: [ask("P-ASK: look up the mail host"), ask("Q-ASK: look up the web host")], reply: "P1: asked Research twice." },
        { key: "P2", match: [LINE], steps: [ask("L-ASK: look up the chat host")], reply: "P2: asked Research." },
        { key: "P-BACK", match: [SETTLED, "Q-ASK: web.example.test"], steps: [ask("P-AGAIN: please still look up the mail host", { expectError: true, rework: true })], reply: "P-BACK: Research was stopped." },
        { key: "L-BACK", match: [SETTLED, "L-ASK: chat.example.test"], steps: [ask("L2-ASK: and the DNS host", { rework: true })], reply: "L-BACK: asked Research again." },
        { key: "L2-DONE", match: [SETTLED, "L2-ASK: dns.example.test"], reply: "L2-DONE: all hosts found." },
      ] },
      [research.id]: { script: [
        { key: "P-ASK", match: ["P-ASK"], readyFile: started, delayMs: 30_000, reply: "P-ASK late: imap.example.test" },
        { key: "Q-ASK", match: ["Q-ASK"], reply: "Q-ASK: web.example.test" },
        { key: "L-ASK", match: ["L-ASK"], delayMs: 5_000, reply: "L-ASK: chat.example.test" },
        { key: "L2-ASK", match: ["L2-ASK"], reply: "L2-ASK: dns.example.test" },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const said = async (threadId: string, text: string) => ((await api(`/api/threads/${threadId}/messages`)).messages as any[]).some((row) => row.text === text);
    const step = (key: string) => evidence().find((turn) => turn.planKey === key)?.evidence.find((entry: any) => entry.step)?.response.result;
    const handoff = (text: string) => readHandoffs(session.info.dataDir).find((node) => node.parentId && node.text.includes(text));

    // One request hands Research two pieces of work in the one thread Post has with it: the second waits behind the first.
    await cli("send", "--bot", asker.id, "--task", asker.activeTaskId, "--text", LINE);
    await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => handoff("Q-ASK")?.status, { timeout: 20_000 }).toBe("queued");
    const first = handoff("P-ASK")!;
    expect(first.status).toBe("running");
    expect(handoff("Q-ASK")!.threadId).toBe(first.threadId);
    // Another request in the same words, in another conversation, has Research working too.
    await cli("send", "--bot", asker.id, "--task", second.threadId, "--text", LINE);
    await expect.poll(() => handoff("L-ASK")?.status, { timeout: 20_000 }).toBe("running");
    expect(handoff("L-ASK")!.rootId).not.toBe(first.rootId);

    expect(await post(`/api/threads/${asker.activeTaskId}/job/as_missing/stop`)).toEqual({ status: 404 });
    expect(await post(`/api/threads/${asker.activeTaskId}/job/${first.id}/stop`)).toEqual({ status: 200, body: { ok: true, outcome: "stopped" } });
    expect(handoff("P-ASK")!.status).toBe("cancelled");
    expect(handoff("Q-ASK")!.status).not.toBe("cancelled");
    expect(handoff("L-ASK")!.status).toBe("running");

    // The work waiting behind it runs to the end; then the stopped request does not get the same work back.
    await expect.poll(() => said(asker.activeTaskId, "P-BACK: Research was stopped."), { timeout: 30_000 }).toBe(true);
    expect(handoff("Q-ASK")).toMatchObject({ status: "completed", threadId: first.threadId });
    expect(JSON.stringify(step("P-BACK"))).toContain("The person stopped this teammate's work on this request.");
    // The other request, in the same words and open before the stop, still hands Research more.
    await expect.poll(() => said(second.threadId, "L2-DONE: all hosts found."), { timeout: 30_000 }).toBe(true);
    expect(step("L-BACK").isError).toBeFalsy();
    expect(handoff("L2-ASK")?.status).toBe("completed");
  } finally {
    await session.close();
  }
}, 120_000);
