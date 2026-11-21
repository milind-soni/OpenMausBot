import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { coordinateMessageMax } from "./too-long.ts";

// A worker hands its result to a checker with the person's request and source: both must arrive whole, or the check
// compares against something the person never gave.

const told = (turn: any): string => {
  const content = turn.prompt?.message?.content;
  return `${turn.system}\n${typeof content === "string" ? content : JSON.stringify(content ?? "")}`;
};

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, options: RequestInit = {}) => request(path, options, session.info.url) as Promise<any>;
  try {
    const worker = (await cli("new-bot", "--name", "Nib")).bot;
    const checker = (await cli("new-bot", "--name", "Vera")).bot;
    const dataDir = session.info.dataDir as string;
    const planPath = join(dataDir, "room-plan.json");
    const turns = (botId: string) => (existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
      .filter((turn: any) => turn.botId === botId);
    const send = async (plan: Record<string, unknown>, text: string) => {
      writeFileSync(planPath, JSON.stringify(plan));
      await cli("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", text);
      expect((await cli("wait", "--bot", worker.id, "--task", worker.activeTaskId, "--timeout", "40")).status).toBe("settled");
    };
    await test({ dataDir, worker, checker, turns, send, api });
  } finally { await session.close(); }
}

const longText = (length: number, end: string) => `${"The harbour lights came on one by one. ".repeat(Math.ceil(length / 39)).slice(0, length - end.length)}${end}`;

it("carries a request as long as a hand-off takes to the checker whole, and refuses a longer one instead of cutting it", () => fixture(async (f) => {
  const whole = longText(coordinateMessageMax, "END-OF-REQUEST");
  const over = longText(coordinateMessageMax + 1, "LOST-TAIL");
  f.plan = {
    [f.worker.id]: { steps: [{ arguments: { bot_ids: [f.checker.id], message: over }, expectError: true }, { arguments: { bot_ids: [f.checker.id], message: whole } }], reply: "Sent for a check", resumeReply: "Checked" },
    [f.checker.id]: { reply: "pass" },
  };
  await f.send(f.plan, "Improve the dialogue and have it checked.");
  const refused = JSON.stringify(f.turns(f.worker.id)[0].evidence.find((entry: any) => entry.step?.arguments?.message === over).response);
  expect(refused).toMatch(/was not run|nothing was done/);
  const brief = told(f.turns(f.checker.id)[0]);
  expect(brief).toContain(whole);
  expect(brief).not.toContain("LOST-TAIL");
}), 90_000);

it("passes the file the person attached on to the checker, byte for byte, and no other stored file", () => fixture(async (f) => {
  const chapter = `# Chapter 3\n\n${longText(40_000, "The door stayed shut.")}\n`;
  const uploaded = await f.api(`/api/files?name=${encodeURIComponent("chapter-3.md")}`, { method: "POST", headers: { "content-type": "text/markdown" }, body: chapter });
  const settings = join(f.dataDir, "config.json");
  expect(existsSync(settings)).toBe(true);
  const elsewhere = await f.api(`/api/files?name=${encodeURIComponent("other.md")}`, { method: "POST", headers: { "content-type": "text/markdown" }, body: "Not in this conversation" });
  expect(uploaded.path).toBeTruthy();
  f.plan = {
    [f.worker.id]: { steps: [
      { arguments: { bot_ids: [f.checker.id], message: "Check this too.", files: [elsewhere.path] }, expectError: true },
      { arguments: { bot_ids: [f.checker.id], message: "And this.", files: [settings] }, expectError: true },
      { arguments: { bot_ids: [f.checker.id], message: "Check my edit of the attached chapter against it.", files: [uploaded.path] } },
    ], reply: "Sent for a check", resumeReply: "Checked" },
    [f.checker.id]: { reply: "pass" },
  };
  await f.send(f.plan, `Improve the dialogue in this chapter.\n<attached-file path="${uploaded.path}" name="chapter-3.md" />\n<attached-file path="${settings}" name="config.json" />`);
  const [refused, outside, sent] = f.turns(f.worker.id)[0].evidence.filter((entry: any) => entry.step?.arguments?.files).map((entry: any) => entry.response.result);
  for (const answer of [refused, outside]) expect(JSON.stringify(answer)).toContain("Nothing was sent");
  expect(sent.isError, JSON.stringify(sent)).toBeFalsy();
  const receipt = JSON.parse(sent.content[0].text);
  const { requestId, threadId } = receipt.receipts[0];
  const landed = join(f.dataDir, "task-workspaces", f.checker.id, threadId, "inbox", "nib", requestId, "chapter-3.md");
  expect(receipt.files).toContain("Passed chapter-3.md to @Vera");
  expect(readFileSync(landed, "utf8")).toBe(chapter);
}), 90_000);

it("refuses a report-back thread brief longer than a hand-off carries instead of cutting it", () => fixture(async (f) => {
  const over = longText(coordinateMessageMax + 1, "LOST-TAIL");
  f.plan = {
    [f.worker.id]: { steps: [{ tool: "start_thread", arguments: { title: "Second opinion", message: over, report_back: true }, expectError: true }], reply: "Could not open it" },
  };
  await f.send(f.plan, "Get a second opinion on this.");
  const refused = JSON.stringify(f.turns(f.worker.id)[0].evidence.find((entry: any) => entry.step?.tool === "start_thread").response);
  expect(refused).toContain("nothing was done");
  expect(f.turns(f.worker.id)).toHaveLength(1);
}), 90_000);

it("says which other provider's AI a checker would start on only when asked: null with one provider, the other with two", async () => {
  for (const extra of [[], ["codex"]] as const) {
    const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true }, [...extra]);
    const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
    try {
      const plain = await api("/api/bot-defaults");
      expect(plain.modelSelection.instanceId).toBe("claude");
      expect(Object.hasOwn(plain, "checkerModelSelection")).toBe(false);
      const checker = await api("/api/bot-defaults?checker=1");
      expect(checker.modelSelection).toEqual(plain.modelSelection);
      if (extra.length) expect(checker.checkerModelSelection).toMatchObject({ instanceId: "codex" });
      else expect(checker.checkerModelSelection).toBeNull();
    } finally { await session.close(); }
  }
}, 120_000);

it("stops a worker and a checker that never agree: rework past four to the same checker under one request is refused", () => fixture(async (f) => {
  const send = (rework: boolean, expectError = false) => ({ arguments: { bot_ids: [f.checker.id], message: "Check result.md against chapter.md and request.md.", rework }, ...(expectError ? { expectError } : {}) });
  f.plan = {
    [f.worker.id]: { turns: [
      { steps: [send(false)], reply: "Being checked." },
      ...Array.from({ length: 4 }, () => ({ steps: [send(true)], reply: "Fixed and sent back." })),
      { steps: [send(true, true)], reply: "Still open after the last round." },
    ] },
    [f.checker.id]: { reply: "issues: 1\n1. Line 1: dusk should be dawn." },
  };
  await f.send(f.plan, "Improve the dialogue and have it checked.");
  await expect.poll(() => f.turns(f.worker.id).length, { timeout: 60_000 }).toBe(6);
  const last = f.turns(f.worker.id)[5].evidence.find((entry: any) => entry.step?.arguments?.rework);
  expect(JSON.stringify(last.response)).toContain("past the limit of 4, so nothing was sent. Stop here");
  expect(f.turns(f.checker.id)).toHaveLength(5);
}), 120_000);
