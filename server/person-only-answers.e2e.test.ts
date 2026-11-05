// Which of the person's own accounts to use is theirs to say, end to end on the scripted engine at Full access. Modelled on
// a real run: the mail bot asked which email account to connect, and the teammate that asked it answered for the person
// ("Gmail, with their address"), which the mail bot then treated as confirmed. Now the question waits on the person, the
// teammate is told not to answer it, and an answer it sends anyway (from the turn resumed with the question) is refused.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("keeps a question about which of the person's accounts to use for the person, and refuses a teammate's answer to it", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const rules = (await cli("new-bot", "--name", "Rules")).bot;
    const mail = (await cli("new-bot", "--name", "Mail")).bot;
    for (const bot of [rules, mail]) await api(`/api/bots/${bot.id}`, { approvalMode: "full" }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [rules.id]: { script: [
        { key: "M1", match: ["M1-JOB"], steps: [{ arguments: { bot_ids: [mail.id], message: "M1-ASK: get email working for the person" } }], reply: "M1: asked Mail." },
        { key: "M1-ASKED", match: ["M1-JOB", "Which email account should be connected"], steps: [{ arguments: { bot_ids: [mail.id], message: "Gmail, with the person's own address" }, expectError: true }],
          reply: "M1-ASKED: Mail needs you to say which email account to connect." },
      ] },
      [mail.id]: { script: [
        { key: "M1-ASK", match: ["M1-ASK"], reply: "No mail account is connected yet.\nNEEDS INPUT: Which email account should be connected — Gmail or another provider?\nDefault: Gmail" },
      ] },
    }));
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const asked = () => readHandoffs(session.info.dataDir).find((node) => node.parentId);
    await cli("send", "--bot", rules.id, "--task", rules.activeTaskId, "--text", "M1-JOB: we must be able to fetch and send mail");
    await expect.poll(() => evidence().some((turn) => turn.planKey === "M1-ASKED"), { timeout: 20_000 }).toBe(true);
    const turn = evidence().find((one) => one.planKey === "M1-ASKED");
    const told = JSON.stringify(turn.prompt);
    expect(told).toContain("waiting on");
    expect(told).toContain("do not answer it for them or pass an answer on");
    expect(told).not.toContain("yours to answer");
    const answer = turn.evidence.find((entry: any) => entry.step).response.result;
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).toContain("only the person can answer");
    expect(asked()).toMatchObject({ status: "waiting", question: expect.stringContaining("Which email account should be connected") });
    expect(evidence().filter((one) => one.botId === mail.id)).toHaveLength(1);
  } finally {
    await session.close();
  }
}, 90_000);
