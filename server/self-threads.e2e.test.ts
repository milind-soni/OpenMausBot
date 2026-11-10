// Who may open a job on itself (start_thread), end to end on the scripted engine. Only a person's own request may: a
// teammate's hand-off and a job the bot opened on itself finish their own work, so a chain can't grow outside the depth,
// budget and stop of the request it serves. The tool's description says so; the server enforces it again here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const SETTLED = "Your downstream room requests have settled.";

it("opens threads on a bot only for a person's own request, never from a hand-off or a job it opened itself", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const asker = (await cli("new-bot", "--name", "Asker")).bot;
    const books = (await cli("new-bot", "--name", "Books")).bot;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const open = (title: string, message: string, expectError: boolean) => ({ tool: "start_thread", arguments: { title, message }, expectError });
    writeFileSync(planPath, JSON.stringify({
      [asker.id]: { script: [
        { key: "J1", match: ["J1-JOB"], steps: [{ arguments: { bot_ids: [books.id], message: "J1-ASK: check each ledger, one thread per ledger" } }], reply: "J1: asked Books." },
        { key: "J1-DONE", match: [SETTLED, "J1-JOB"], reply: "J1-DONE: Books checked the ledgers." },
      ] },
      [books.id]: { script: [
        { key: "J1-ASK", match: ["J1-ASK"], steps: [open("Ledger 1", "J1-SELF: check ledger 1", true)], reply: "J1-ASK: checked both ledgers here." },
        { key: "J2", match: ["J2-JOB"], steps: [open("Ledger A", "J2-SELF: check ledger A", false)], reply: "J2: opened Ledger A." },
        { key: "J2-SELF", match: ["J2-SELF"], steps: [open("Sub-ledger", "J2-DEEPER: check the sub-ledger", true)], reply: "J2-SELF: ledger A balances." },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const result = (key: string) => evidence().find((turn) => turn.planKey === key)?.evidence.find((entry: any) => entry.step?.tool === "start_thread")?.response.result;
    const titles = async () => ((await api("/api/bots")).bots.find((bot: any) => bot.id === books.id).tasks as any[]).map((task) => task.title);

    // A teammate's hand-off: the work is done in the hand-off's thread.
    await cli("send", "--bot", asker.id, "--task", asker.activeTaskId, "--text", "J1-JOB: have Books check the ledgers");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J1-DONE"), { timeout: 20_000 }).toBe(true);
    expect(result("J1-ASK").isError).toBe(true);
    expect(JSON.stringify(result("J1-ASK"))).toContain("Only a person's own request can open separate threads on yourself");

    // The person's own request opens a job; that job opens no more. A self-opened thread quotes this thread's title,
    // which is the first line, so the script token stays on the next line.
    await cli("send", "--bot", books.id, "--task", books.activeTaskId, "--text", "Open one thread per ledger.\nJ2-JOB");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "J2-SELF"), { timeout: 20_000 }).toBe(true);
    expect(result("J2").isError).toBeFalsy();
    expect(result("J2-SELF").isError).toBe(true);
    expect(await titles()).toContain("Ledger A");
    expect(await titles()).not.toContain("Ledger 1");
    expect(await titles()).not.toContain("Sub-ledger");
    expect(evidence().some((turn) => turn.planKey === undefined)).toBe(false);
  } finally {
    await session.close();
  }
}, 90_000);
