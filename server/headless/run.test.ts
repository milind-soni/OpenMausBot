import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;
const URL_ENV = { OPENMAUSBOT_URL: "http://127.0.0.1:19999" };

const job = (state: string, version: string, extra: Rec = {}) => ({ threadId: "t1", state, version, since: 1_000, reason: `${state} now`, counts: {}, nodes: [], needsInput: [], ...extra });
const waited = (status: string, state: string, jobView: Rec, extra: Rec = {}) => ({
  status, state, targetType: "bot", targetId: "lead", taskId: "t1", target: { id: "lead" }, hasMore: false, job: jobView,
  messages: [{ role: "user", kind: "text", text: "Rehearse" }, { role: "bot", kind: "text", text: "Report: [report](report.md) and ![shot](shots/1.png) at [site](https://example.com)" }],
  ...extra,
});

function harness(waits: Rec[], options: { jobRead?: () => unknown; delayMs?: number; drops?: unknown[] } = {}) {
  const calls: Array<{ name: string; args: Rec }> = [];
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  let wait = 0;
  const callTool = vi.fn(async (name: string, args: Rec, _fetcher: unknown, signal?: AbortSignal, hooks?: { onProgress?(job: Rec): void }) => {
    calls.push({ name, args });
    if (name === "create_task") return { success: true, task: { taskId: "t1" } };
    if (name === "send_bot_message") return { success: true, botId: "lead", taskId: "t1", messageId: "m1", at: 5 };
    if (name === "interrupt_conversation") return { success: true, targetType: "bot", targetId: "lead", taskId: "t1" };
    if (name === "wait_for_conversation") {
      if (options.drops?.length) throw options.drops.shift();
      // held like the real tool, which gives up when its signal is aborted
      if (options.delayMs) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("Request cancelled"), { name: "AbortError" })); }, { once: true });
      });
      const result = waits[Math.min(wait++, waits.length - 1)]!;
      hooks?.onProgress?.(result.job);
      return result;
    }
    throw new Error(`unexpected tool ${name}`);
  });
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    requests.push({ path, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/bots?messages=0") return { bots: [{ id: "lead", name: "Room Lead", threadId: "t0", tasks: [{ threadId: "t0" }, { threadId: "t1" }] }], groups: [] };
    if (/^\/api\/threads\/t[01]\/job/.test(path)) return options.jobRead ? options.jobRead() : job("idle", "v0", { now: 1_000 });
    if (path.endsWith("/interrupt")) return { ok: true };
    throw new Error(`unexpected path ${path}`);
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "from stdin" };
  const run = async (argv: string[], signal?: AbortSignal) => {
    const code = await runHeadless(argv, { env: URL_ENV, io, callTool: callTool as any, request: request as any, ...(signal ? { signal } : {}) });
    return { code, result: out.length ? JSON.parse(out.at(-1)!) : undefined, progress: err.map((line) => JSON.parse(line)) };
  };
  return { calls, requests, run };
}

describe("run", () => {
  it("opens a conversation, pins the job to the server's clock, sends once with a send id, and waits for the whole job", async () => {
    const h = harness([waited("settled", "completed", job("completed", "v2", { nodes: [{ id: "root", status: "completed" }] }))]);
    const { code, result, progress } = await h.run(["run", "Room Lead", "Rehearse the launch\nof example.com", "--json"]);
    expect(code).toBe(0);
    expect(h.calls.map((call) => call.name)).toEqual(["create_task", "send_bot_message", "wait_for_conversation"]);
    expect(h.calls[0]!.args).toEqual({ target_type: "bot", target_id: "lead", title: "Rehearse the launch" });
    expect(h.calls[1]!.args).toEqual({ bot_id: "lead", task_id: "t1", text: "Rehearse the launch\nof example.com", send_id: expect.stringMatching(/^cli-[\w-]{16}$/) });
    expect(h.calls[2]!.args).toEqual({ target_type: "bot", target_id: "lead", task_id: "t1", timeout_seconds: 120, scope: "job", since_ms: 1_000 });
    expect(h.requests.map((request) => request.path)).toEqual(["/api/bots?messages=0", "/api/threads/t1/job?"]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, threadId: "t1", since: 1_000, state: "completed",
      reply: { text: expect.stringContaining("Report:"), files: ["report.md", "shots/1.png"] } });
    expect(progress[0]).toMatchObject({ event: "started", threadId: "t1", messageId: "m1", since: 1_000 });
    expect(progress[1]).toMatchObject({ event: "job", state: "completed" });
  });

  it("fails (1) when no turn ran for the message, where wait on an idle conversation is done", async () => {
    // a room set to answer mentions, sent a message that names nobody
    const nobody = () => harness([waited("settled", "idle", job("idle", "v1", { reason: "Nothing is running in this conversation" }))]);
    const ran = await nobody().run(["run", "Room Lead", "Hello, anyone?", "--json"]);
    expect(ran.code).toBe(1);
    expect(ran.result).toMatchObject({ ok: false, exitCode: 1, state: "idle", reason: expect.stringContaining("no turn ran for the message") });
    expect((await nobody().run(["wait", "--bot", "lead", "--json"])).code).toBe(0);
  });

  it("reads the message from stdin with -, and does not wait with --wait none", async () => {
    const h = harness([]);
    const { code, result } = await h.run(["run", "Room Lead", "-", "--wait", "none", "--task", "current", "--json"]);
    expect(code).toBe(0);
    expect(h.calls.map((call) => call.name)).toEqual(["send_bot_message"]);
    expect(h.calls[0]!.args).toMatchObject({ task_id: "t0", text: "from stdin" });
    expect(result).toMatchObject({ ok: true, threadId: "t0" });
  });

  it("refuses an export folder that already has files before sending anything (exit 2), unless --force", async () => {
    const used = mkdtempSync(join(tmpdir(), "omb-run-export-"));
    try {
      writeFileSync(join(used, "earlier.txt"), "from an earlier run");
      const h = harness([waited("settled", "completed", job("completed", "v1"))]);
      const { code, result } = await h.run(["run", "Room Lead", "Go", "--export", used, "--json"]);
      expect(code).toBe(2);
      expect(result).toMatchObject({ ok: false, exitCode: 2, error: `${used} already has files in it` });
      expect(h.calls).toEqual([]);
      expect(h.requests).toEqual([]);
      const forced = harness([waited("settled", "completed", job("completed", "v1"))]);
      expect((await forced.run(["run", "Room Lead", "Go", "--export", used, "--force", "--json"])).result).toMatchObject({ ok: true });
      expect(forced.calls.map((call) => call.name)).toEqual(["create_task", "send_bot_message", "wait_for_conversation"]);
    } finally {
      rmSync(used, { recursive: true, force: true });
    }
  });

  it("stops waiting on Ctrl-C (130), and says how to wait on the same job from the same moment", async () => {
    const controller = new AbortController();
    const h = harness([waited("settled", "completed", job("completed", "v1"))], { delayMs: 10_000 });
    setTimeout(() => controller.abort(), 50);
    const { code, result } = await h.run(["run", "--bot", "lead", "Go", "--json"], controller.signal);
    expect(code).toBe(130);
    expect(result).toMatchObject({ exitCode: 130, error: "stopped waiting; the work keeps running", hint: "wait again: openmausbot wait --thread t1 --since 1000" });
    expect(h.calls.some((call) => call.name === "interrupt_conversation")).toBe(false);
  });

  it("refuses a server that cannot report a job before sending anything (exit 5)", async () => {
    const h = harness([], { jobRead: () => { throw Object.assign(new Error("OpenMausBot API error (404): not found"), { status: 404 }); } });
    const { code, result } = await h.run(["run", "--bot", "lead", "Go", "--json"]);
    expect(code).toBe(5);
    expect(result).toMatchObject({ ok: false, exitCode: 5, error: "this OpenMausBot server cannot report a conversation's job" });
    expect(h.calls.map((call) => call.name)).toEqual(["create_task"]);
  });
});

describe("wait", () => {
  it("carries a long wait across tool calls, keeping the same job and asking only for a change", async () => {
    const h = harness([
      waited("timed-out", "timed-out", job("running", "v1")),
      waited("timed-out", "timed-out", job("running", "v2")),
      waited("settled", "completed", job("completed", "v3")),
    ]);
    const { code } = await h.run(["wait", "--bot", "lead", "--task", "t1", "--timeout", "10m", "--json"]);
    expect(code).toBe(0);
    expect(h.calls.map((call) => call.args)).toEqual([
      { target_type: "bot", target_id: "lead", task_id: "t1", timeout_seconds: 120, scope: "job" },
      { target_type: "bot", target_id: "lead", task_id: "t1", timeout_seconds: 120, scope: "job", since_ms: 1_000, after_version: "v1" },
      { target_type: "bot", target_id: "lead", task_id: "t1", timeout_seconds: 120, scope: "job", since_ms: 1_000, after_version: "v2" },
    ]);
  });

  it("exits 3 when someone must answer, waits through it with --on-input wait, and stops the job with --on-input stop", async () => {
    const needs = waited("needs-user", "needs-input", job("needs-input", "v1", { nodes: [
      { id: "root", botId: "lead", threadId: "t1", status: "waiting" },
      { id: "a1", botId: "priya", botName: "Priya", threadId: "p1", status: "needs_input" },
      { id: "a2", botId: "marcus", botName: "Marcus", threadId: "m1", groupId: "g1", status: "running" },
      { id: "a3", botId: "kenji", botName: "Kenji", threadId: "k1", status: "completed" },
    ], needsInput: [{ botName: "Priya", question: "Which tier?" }] }));
    expect((await harness([needs]).run(["wait", "--bot", "lead", "--json"])).code).toBe(3);

    const answered = harness([needs, waited("settled", "completed", job("completed", "v2"))]);
    expect((await answered.run(["wait", "--bot", "lead", "--on-input", "wait", "--json"])).code).toBe(0);
    expect(answered.calls[1]!.args).toMatchObject({ after_version: "v1" });

    expect((await harness([needs], { delayMs: 50 }).run(["wait", "--bot", "lead", "--on-input", "wait", "--timeout", "1", "--json"])).code).toBe(4);

    const left = [...needs.job.nodes,
      { id: "a4", botId: "lena", botName: "Lena", threadId: "l1", status: "queued" },
      { id: "a5", botId: "priya", botName: "Priya", threadId: "p1", status: "running" },
      { id: "a6", botId: "kenji", botName: "Kenji", threadId: "k2", status: "resume" }];
    const stopped = harness([needs], { jobRead: () => job("needs-input", "v1", { nodes: left }) });
    const { code, result } = await stopped.run(["wait", "--bot", "lead", "--on-input", "stop", "--json"]);
    expect(code).toBe(3);
    expect(stopped.calls.at(-1)).toEqual({ name: "interrupt_conversation", args: { target_type: "bot", target_id: "lead", task_id: "t1" } });
    expect(stopped.requests.filter((request) => request.path.startsWith("/api/threads/t1/job")).map((request) => request.path))
      .toEqual(["/api/threads/t1/job?", "/api/threads/t1/job?since=1000"]);
    expect(stopped.requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/bots/priya/interrupt", method: "POST", body: { threadId: "p1" } },
      { path: "/api/groups/g1/interrupt", method: "POST", body: { threadId: "m1" } },
      { path: "/api/bots/kenji/interrupt", method: "POST", body: { threadId: "k2" } },
    ]);
    expect(result.stopped.map((node: Rec) => node.botName)).toEqual(["Priya", "Marcus", "Kenji"]);
  });

  it("counts a teammate the conversation's Stop ended with it as stopped, and presses Stop again only where work is left", async () => {
    const needs = waited("needs-user", "needs-input", job("needs-input", "v1", { needsInput: [{ botName: "Priya", question: "Which tier?" }] }));
    const before = [
      { id: "root", botId: "lead", threadId: "t1", status: "waiting" },
      { id: "a1", botId: "priya", botName: "Priya", threadId: "p1", status: "running" },
      { id: "a2", botId: "lena", botName: "Lena", threadId: "l1", status: "queued" },
      { id: "a3", botId: "kenji", botName: "Kenji", threadId: "k1", status: "cancelled" },
    ];
    const after = [{ ...before[0], status: "cancelled" }, { ...before[1], status: "cancelled" }, { ...before[2], status: "cancelled" }, before[3],
      { id: "a4", botId: "marcus", botName: "Marcus", threadId: "m1", status: "running" }];
    let reads = 0;
    const stopped = harness([needs], { jobRead: () => job("needs-input", "v1", { nodes: reads++ === 0 ? before : after }) });
    const { code, result } = await stopped.run(["wait", "--bot", "lead", "--on-input", "stop", "--json"]);
    expect(code).toBe(3);
    // Priya was at work and ended with the Stop; Lena never started and Kenji had ended before it.
    expect(result.stopped.map((node: Rec) => node.botName)).toEqual(["Priya", "Marcus"]);
    expect(stopped.requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/bots/marcus/interrupt", method: "POST", body: { threadId: "m1" } },
    ]);
  });

  it("times out (4) and leaves the work running unless --on-timeout stop; --strict fails a run whose teammate failed", async () => {
    const running = waited("timed-out", "timed-out", job("running", "v1"));
    const left = harness([running], { delayMs: 20 });
    expect((await left.run(["wait", "--bot", "lead", "--timeout", "1", "--json"])).code).toBe(4);
    expect(left.calls.some((call) => call.name === "interrupt_conversation")).toBe(false);
    const stopped = harness([running], { delayMs: 20, jobRead: () => job("running", "v1") });
    expect((await stopped.run(["wait", "--bot", "lead", "--timeout", "1", "--on-timeout", "stop", "--json"])).code).toBe(4);
    expect(stopped.calls.at(-1)!.name).toBe("interrupt_conversation");
    const failedTeammate = waited("settled", "completed", job("completed", "v1", { nodes: [{ id: "root", status: "completed" }, { id: "a1", status: "failed" }] }));
    expect((await harness([failedTeammate]).run(["wait", "--bot", "lead", "--json"])).code).toBe(0);
    expect((await harness([failedTeammate]).run(["wait", "--bot", "lead", "--strict", "--json"])).code).toBe(1);
    // a part this session cannot see (or past the nodes shown) is in the counts
    const hiddenFailure = waited("settled", "completed", job("completed", "v1", { nodes: [{ id: "root", status: "completed" }], hidden: 1,
      counts: { queued: 0, running: 0, waiting: 0, needsInput: 0, completed: 1, failed: 1, cancelled: 0 } }));
    expect((await harness([hiddenFailure]).run(["wait", "--bot", "lead", "--json"])).code).toBe(0);
    expect((await harness([hiddenFailure]).run(["wait", "--bot", "lead", "--strict", "--json"])).code).toBe(1);
    expect((await harness([waited("failed", "failed", job("failed", "v1"))]).run(["wait", "--bot", "lead", "--json"])).code).toBe(1);
    expect((await harness([waited("settled", "failed", job("failed", "v1"))]).run(["wait", "--bot", "lead", "--json"])).code).toBe(1);
  });

  it("keeps waiting on the same job when the server drops for a moment, and gives up on a refusal", async () => {
    const dropped = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const proxy = Object.assign(new Error("OpenMausBot API error (502): Bad Gateway"), { status: 502 });
    const h = harness([waited("timed-out", "timed-out", job("running", "v1")), waited("settled", "completed", job("completed", "v2"))], { drops: [dropped] });
    const first = h.run(["wait", "--thread", "t1", "--since", "1000", "--json"]);
    const { code, progress } = await first;
    expect(code).toBe(0);
    expect(progress.filter((event: Rec) => event.event === "reconnecting")).toEqual([{ event: "reconnecting", inMs: 1_000, threadId: "t1" }]);
    expect(h.calls.filter((call) => call.name === "wait_for_conversation").map((call) => call.args.since_ms)).toEqual([1_000, 1_000, 1_000]);
    expect((await harness([waited("settled", "completed", job("completed", "v1"))], { drops: [proxy] }).run(["wait", "--thread", "t1", "--json"])).code).toBe(0);
    const refused = Object.assign(new Error("OpenMausBot API error (401): {\"error\":\"unauthorized\"}"), { status: 401 });
    const gone = harness([waited("settled", "completed", job("completed", "v1"))], { drops: [refused] });
    expect((await gone.run(["wait", "--thread", "t1", "--json"])).code).toBe(5);
    expect(gone.calls.filter((call) => call.name === "wait_for_conversation")).toHaveLength(1);
    // a bug's TypeError is not a dropped connection: it fails at once
    const bug = harness([waited("settled", "completed", job("completed", "v1"))], { drops: [new TypeError("Cannot read properties of undefined (reading 'job')")] });
    expect((await bug.run(["wait", "--thread", "t1", "--json"])).code).toBe(1);
    expect(bug.calls.filter((call) => call.name === "wait_for_conversation")).toHaveLength(1);
  }, 15_000);

  it("stops waiting on Ctrl-C (130), leaves the work running, and says how to pick it up again", async () => {
    const controller = new AbortController();
    const h = harness([waited("settled", "completed", job("completed", "v1"))], { delayMs: 10_000 });
    setTimeout(() => controller.abort(), 50);
    const { code, result } = await h.run(["wait", "--thread", "t1", "--json"], controller.signal);
    expect(code).toBe(130);
    expect(result).toMatchObject({ ok: false, exitCode: 130, error: "stopped waiting; the work keeps running", hint: "wait again: openmausbot wait --thread t1" });
    expect(h.calls.some((call) => call.name === "interrupt_conversation")).toBe(false);
  });
});
