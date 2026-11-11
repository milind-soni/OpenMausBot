// A fake broker on the socket stands in for the harness.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brokerSocketPath } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { formatQuestionAnswers } from "../shared/ask-question.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");

/** The shape the real CLI sends (verified against claude 2.1.238). */
const QUESTION = {
  questions: [
    {
      question: "Which framework should we use?",
      header: "Framework",
      multiSelect: false,
      options: [
        { label: "React", description: "What the app already uses" },
        { label: "Vue", description: "Smaller, but a rewrite" },
      ],
    },
  ],
};

describe("permission proxy", () => {
  let scratch: string;
  let broker: Server;
  let proxy: ChildProcess;
  let asks: any[];
  let answerWith: (ask: any, index: number) => Record<string, unknown> | null;
  let conns: Socket[];
  let listen: () => Promise<void>;
  const results = new Map<number, any>();

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for id ${id}; asks so far: ${JSON.stringify(asks)}`);
  };
  const waitForAsks = async (count: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (asks.length >= count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`only ${asks.length} of ${count} asks arrived`);
  };
  const resultJson = (res: any) => JSON.parse(res.result.content[0].text);

  const startProxy = (socketPath: string, env?: NodeJS.ProcessEnv) => {
    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY, socketPath], { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    proxy.stdout!.setEncoding("utf8");
    proxy.stdout!.on("data", (chunk) => {
      out += chunk; let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        if (!line.trim()) continue;
        try { const msg = JSON.parse(line); if (msg.id != null) results.set(msg.id, msg); } catch {}
      }
    });
  };

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-perm-proxy-"));
    asks = [];
    conns = [];
    answerWith = () => null;
    const socketPath = brokerSocketPath(scratch, "test");
    listen = async () => {
      broker = createServer(onConnection);
      await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
    };
    const onConnection = (conn: Socket) => {
      conns.push(conn);
      let buf = "";
      conn.on("error", () => {});
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ask = JSON.parse(line);
          if (ask.t !== "ask") continue;
          const index = asks.length;
          asks.push(ask);
          const answer = answerWith(ask, index);
          if (answer) conn.write(JSON.stringify({ t: "answer", id: ask.id, ...answer }) + "\n");
        }
      });
    };
    await listen();

    startProxy(socketPath);
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterEach(async () => {
    results.clear();
    proxy?.kill();
    if (broker.listening) await new Promise<void>((resolve) => broker.close(() => resolve()));
    removeTempDir(scratch);
  });

  /** The broker stops listening and drops every connection, as when the socket is gone or unreachable. */
  const brokerGone = async () => {
    for (const conn of conns.splice(0)) conn.destroy();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  };

  it("withholds an excluded question without losing the CLI permission callback", async () => {
    const exited = once(proxy, "exit"); proxy.kill(); await exited; results.clear();
    startProxy(brokerSocketPath(scratch, "test"), { ...process.env, OMB_PERMISSION_TOOL_SCOPE: JSON.stringify({ allow: ["native:*"] }) });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await waitFor(2)).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["approve"]);
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_user", arguments: { question: "Must not ask" } } });
    expect((await waitFor(3)).result.content[0].text).toContain("excluded"); expect(asks).toEqual([]);
    answerWith = () => ({ behavior: "allow" });
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: {} } } });
    expect(resultJson(await waitFor(4)).behavior).toBe("allow"); expect(asks).toHaveLength(1);
  });

  it("exposes approve and ask_user", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    expect(res.result.tools.map((tool: any) => tool.name)).toEqual(["approve", "ask_user"]);
  });

  it("asks AskUserQuestion as ONE question card carrying every question it posed", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which framework should we use?\nA: React",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    const res = await waitFor(2);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which framework should we use?",
            options: [
              { label: "React", description: "What the app already uses" },
              { label: "Vue", description: "Smaller, but a rewrite" },
            ],
          },
        ],
      },
    });

    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { ...QUESTION, answers: { "Which framework should we use?": "React" } },
    });
  });

  it("returns an answer for every question the one card collected", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Search" }] },
      ],
    };
    answerWith = () => ({
      behavior: "answer",
      message:
        "The user answered your questions.\n\nQ: Which framework?\nA: React\n\nQ: Which features?\nA: Auth, Search",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);

    expect(asks).toHaveLength(1);
    expect(asks[0].input.questions.map((q: { question: string }) => q.question))
      .toEqual(["Which framework?", "Which features?"]);
    expect(asks[0].input.questions[1].multiSelect).toBe(true);
    expect(resultJson(res).updatedInput.answers).toEqual({
      "Which framework?": "React",
      "Which features?": "Auth, Search",
    });
  });

  it("delivers pasted Q/A text to Claude as one answer without overwriting another", async () => {
    const input = { questions: [
      { question: "Which framework?", options: [] },
      { question: "Which features?", options: [] },
    ] };
    const pasted = "Notes\n\nQ: Which framework?\nA: Vue";
    answerWith = () => ({ behavior: "answer", source: "user", message: formatQuestionAnswers(input.questions, [["React"], [pasted]]) });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } } });
    expect(resultJson(await waitFor(2))).toEqual({
      behavior: "allow", updatedInput: { ...input, answers: { "Which framework?": "React", "Which features?": pasted } },
    });
  });

  it("files a timeout's own note as unanswered, not as the user's choice", async () => {
    // What the broker actually sends on a timeout: `answer`, source "timeout", and a full sentence.
    answerWith = () => ({
      behavior: "answer",
      message: "OpenMausBot: nobody answered in time. Use your best judgment and continue.",
      source: "timeout",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({});
  });

  it("treats the turn ending the same way — system words are not the user's answer", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "OpenMausBot: the turn is ending — wrap up.",
      source: "system",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({});
  });

  it("denies when the broker is gone, rather than reporting an empty answer", async () => {
    answerWith = () => ({ behavior: "deny", message: "OpenMausBot: permission broker unavailable" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2))).toMatchObject({ behavior: "deny" });
  });

  it("denies an unanswerable AskUserQuestion instead of carding it as a permission", async () => {
    answerWith = () => ({ behavior: "allow" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: { tool_name: "AskUserQuestion", input: { questions: [{ options: [{ label: "Yes" }] }] } },
      },
    });
    const res = await waitFor(2);
    expect(asks).toHaveLength(0);
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
    expect(resultJson(res).message).toContain("no answerable question");
  });

  it("keeps the good questions when one entry in the same call has no text", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { options: [{ label: "orphaned" }] },
      ],
    };
    answerWith = () => ({
      behavior: "answer",
      message: "The user answered your questions.\n\nQ: Which framework?\nA: React",
      source: "user",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);
    expect(asks[0].input.questions.map((q: { question: string }) => q.question)).toEqual(["Which framework?"]);
    expect(resultJson(res).updatedInput.answers).toEqual({ "Which framework?": "React" });
  });

  it("still brokers an ordinary permission, with the CLI's own rules on allow", async () => {
    answerWith = () => ({ behavior: "allow", always: true });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: {
          tool_name: "Bash",
          input: { command: "git status" },
          permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
        },
      },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ tool: "Bash", input: { command: "git status" } });
    expect(asks[0].kind).toBeUndefined();
    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git status" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
  });

  it("hands a large non-ASCII tool input back to the CLI byte for byte", async () => {
    // About 1.5 MB of three-byte characters: the line spans many pipe reads, most boundaries inside a character.
    const content = "中文ok€".repeat(150_000);
    answerWith = () => ({ behavior: "allow" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "notes.md", content } } },
    });
    const res = await waitFor(2, 20_000);
    expect(asks[0].input.content === content).toBe(true);
    const updated = resultJson(res).updatedInput.content as string;
    expect(updated.includes("\uFFFD")).toBe(false);
    expect(updated === content).toBe(true);
  }, 30_000);

  it("still asks ask_user as a question and returns the words verbatim", async () => {
    answerWith = () => ({ behavior: "answer", message: "ship it", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Ready?", choices: ["ship it", "wait"] } },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ kind: "question", tool: "ask_user", input: { question: "Ready?" } });
    expect(res.result.content[0].text).toBe("ship it");
  });

  it("asks a multiSelect ask_user as a checkbox question and returns the picks", async () => {
    const card = [{ question: "Which fruits?", multiSelect: true, options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }] }];
    answerWith = () => ({ behavior: "answer", source: "user", message: formatQuestionAnswers(card, [["Apple", "Cherry"]]) });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Which fruits?", choices: ["Apple", "Banana", "Cherry"], multiSelect: true } },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ kind: "question", tool: "ask_user", input: { question: "Which fruits?", questions: card } });
    expect(res.result.content[0].text).toBe("Apple, Cherry");
  });

  it("keeps a multiSelect ask_user's system note as the note, not as picks", async () => {
    answerWith = () => ({ behavior: "answer", source: "timeout", message: "Nobody answered in time." });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Which fruits?", choices: ["Apple", "Banana"], multiSelect: true } },
    });
    expect((await waitFor(2)).result.content[0].text).toBe("Nobody answered in time.");
  });

  it("leaves a single-pick ask_user without a question card", async () => {
    answerWith = () => ({ behavior: "answer", message: "wait", source: "user" });
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "Ready?", choices: ["ship it", "wait"], multiSelect: false } } });
    await waitFor(2);
    expect(asks[0].input.questions).toBeUndefined();
  });

  it("denies every waiting ask when the broker dies", async () => {
    answerWith = () => null;
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "sleep 1" } } },
    });
    await waitForAsks(1);
    for (const conn of conns) conn.destroy();
    const res = await waitFor(2);
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
  });

  it("tells a waiting question what to do when its connection drops, and asks the next one on a new connection", async () => {
    answerWith = () => null;
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "One?" } } });
    await waitForAsks(1);
    for (const conn of conns.splice(0)) conn.destroy();
    const dropped = await waitFor(2);
    expect(dropped.result.isError).toBe(true);
    expect(dropped.result.content[0].text).toContain("Ask in your reply instead");
    answerWith = () => ({ behavior: "answer", message: "second", source: "user" });
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_user", arguments: { question: "Two?" } } });
    expect((await waitFor(3)).result.content[0].text).toBe("second");
    expect(asks.map((ask) => ask.input.question)).toEqual(["One?", "Two?"]);
    expect(conns).toHaveLength(1);
  });

  it("tells the bot what to do instead while nobody can be asked, and asks once the broker is back", async () => {
    await brokerGone();
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { question: "Which account?" } } });
    const question = await waitFor(2);
    expect(question.result.isError).toBe(true);
    expect(question.result.content[0].text).toMatch(/could not show this question to the person.*Ask in your reply instead: end it with the exact question/);
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "git push" } } } });
    expect(resultJson(await waitFor(3))).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/could not ask the person to approve this step.*Skip this step, and say in your reply what you wanted to do and why/),
    });
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } } });
    expect(resultJson(await waitFor(4))).toMatchObject({ behavior: "deny", message: expect.stringContaining("Ask in your reply instead") });
    expect(asks).toEqual([]);

    await listen();
    answerWith = () => ({ behavior: "answer", message: "Work", source: "user" });
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask_user", arguments: { question: "Which account?" } } });
    const answered = await waitFor(5);
    expect(answered.result.content[0].text).toBe("Work");
    expect(answered.result.isError).toBeUndefined();
    expect(asks).toHaveLength(1);
  }, 20_000);
});
