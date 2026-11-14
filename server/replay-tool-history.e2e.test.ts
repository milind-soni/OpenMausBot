import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import type { WireMessage } from "../shared/wire.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

it("names earlier tool calls in a rebuilt session only when switched on", async () => {
  const fixture = await launchVerificationServer({
    // The launcher keeps only OS launch variables and FAKE_CLAUDE_* knobs.
    ...process.env,
    // every turn runs a failing command and a read before it replies
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { name: "Bash", input: { command: "pnpm test", description: "INPUT_PREVIEW_ONLY" }, output: "RESULT_BODY 3 failed", ok: false },
      { name: "Read", input: { file_path: "/fixture/notes.md", limit: 40 }, output: "RESULT_BODY notes", ok: true },
    ]),
  }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const bot = (await control("new-bot", "--name", "Replay probe")).bot;
    const thread: string = bot.activeTaskId;
    const messages = async () =>
      (await request(`/api/threads/${thread}/messages?limit=100`, {}, fixture.info.url) as { messages: WireMessage[] }).messages;
    const settled = async () =>
      expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    /** The text the provider received for the turn that just settled. */
    const prompt = () => {
      const text = withoutTurnClock(String(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt.message.content));
      evidence.push({ prompt: text });
      return text;
    };
    const send = async (text: string) => {
      await control("send", "--bot", bot.id, "--task", thread, "--text", text);
      await settled();
      return prompt();
    };
    /** Rewind: edit the latest user message, which replays the surviving branch. */
    const rewind = async (text: string) => {
      const latest = (await messages()).findLast(message => message.role === "user")!;
      await control("edit", "--bot", bot.id, "--task", thread, "--message", latest.id, "--text", text);
      await settled();
      return prompt();
    };
    const toolLines = (text: string) => text.split("\n").filter(line => line.startsWith("Assistant: [ran: "));

    await send("FIRST_REQUEST run the tests");
    const calls = (await messages()).filter(message => message.tool?.itemId);
    expect(calls.map(message => [message.tool?.name, message.tool?.ok])).toEqual([["Bash", false], ["Read", true]]);
    // the Read's chip shows no file: the path is only in the stored input preview
    expect(calls[1]!.tool).toMatchObject({ name: "Read", input: expect.stringContaining('"file_path": "/fixture/notes.md"') });
    expect(calls[1]!.tool?.summary).toBeUndefined();

    // A turn that resumes its session is sent the message, and no replay.
    expect(await send("SECOND_REQUEST anything else?")).toBe("SECOND_REQUEST anything else?");

    // Off (the default): the rewind replays what was said, as it always has.
    const off = await rewind("SECOND_REQUEST, edited");
    expect(off).toContain("rewound this conversation");
    expect(off).toContain("User: FIRST_REQUEST run the tests");
    expect(off).not.toContain("[ran: ");

    await request("/api/config", { method: "PATCH", body: JSON.stringify({ context: { replayToolHistory: true } }) }, fixture.info.url);

    // On: the same replay, plus one line per earlier call, between the
    // request it followed and the reply it led to: the command that ran,
    // and the file that was read.
    const on = await rewind("SECOND_REQUEST, edited again");
    expect(toolLines(on)).toEqual(["Assistant: [ran: Bash: pnpm test — failed]", "Assistant: [ran: Read: /fixture/notes.md — ok]"]);
    expect(on).toMatch(/User: FIRST_REQUEST run the tests\nAssistant: \[ran: Bash: pnpm test — failed\]\nAssistant: \[ran: Read: \/fixture\/notes\.md — ok\]\nAssistant: (?!\[)/);
    // no tool result, and of the input preview behind the chip only its target
    expect(on).not.toContain("RESULT_BODY");
    expect(on).not.toContain("INPUT_PREVIEW_ONLY");
    // and nothing else moved: without those lines it is the replay sent while off
    expect(on.split("\n").filter(line => !line.startsWith("Assistant: [ran: ")).join("\n"))
      .toBe(off.replace("SECOND_REQUEST, edited", "SECOND_REQUEST, edited again"));

    // Still on, a turn that resumes its session is sent no replay.
    expect(await send("THIRD_REQUEST thanks")).toBe("THIRD_REQUEST thanks");

    // An engine switched in mid-thread joins through the same replay: Codex
    // is told what each of Claude's three turns on this branch ran.
    const codex = (await control("models")).instances.find((item: any) => item.instanceId === "codex");
    await request(`/api/bots/${bot.id}/tasks/${thread}`, { method: "PATCH", body: JSON.stringify({
      modelSelection: { instanceId: "codex", model: codex.models.options[0].id }, requireAvailableModel: true,
    }) }, fixture.info.url);
    await control("send", "--bot", bot.id, "--task", thread, "--text", "FOURTH_REQUEST carry on");
    await settled();
    // the harness's own record of what it sent that engine
    const sent = readFileSync(join(fixture.info.dataDir, "native", `${thread}.ndjson`), "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).findLast(entry => entry.dir === "out" && entry.msg?.method === "turn/start");
    const joined = withoutTurnClock((sent.msg.params.input as Array<{ text?: string }>).map(part => part.text ?? "").join("\n"));
    evidence.push({ codex: joined });
    expect(joined).toContain("joining this conversation mid-thread");
    expect(toolLines(joined)).toEqual([...toolLines(on), ...toolLines(on), ...toolLines(on)]);
    expect(joined).not.toContain("RESULT_BODY");
    expect(joined.endsWith("FOURTH_REQUEST carry on")).toBe(true);

    // The lines are built for the replay; the stored conversation has none.
    expect(JSON.stringify(await messages())).not.toContain("[ran: ");
  } finally {
    try {
      writeFileSync(`${fixture.info.logPath}.replay-tools.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.info(`Replay tool-history evidence: ${fixture.info.logPath}.replay-tools.json`);
    } finally { await fixture.close(); }
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 120_000);
