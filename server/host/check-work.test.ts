import { describe, expect, it } from "vitest";

import { CHECK_WORK_MAX_MS } from "../../shared/check-work.ts";
import type { HostTurnResult } from "../coordinator.ts";
import { serverLine } from "../server-lines.ts";
import type { Message } from "../store.ts";
import { createCheckWork, readVerdict, type CheckWorkBot } from "./check-work.ts";

type Line = Partial<Message> & { id: string };
type Reply = { ok?: boolean; text?: string; failure?: string; throws?: string; meanwhile?: () => void };

/** One bot that answered the person, a checker, and engines that answer from a script, on a clock the test moves. */
function fixture(options: { checkWork?: CheckWorkBot["checkWork"]; checkerReplies?: Reply[]; fixes?: Reply[]; chapter?: string } = {}) {
  let ids = 0, clock = 0;
  const id = () => `m${++ids}`;
  const bots = new Map<string, CheckWorkBot>([
    ["w", { id: "w", name: "Nib", checkWork: options.checkWork === undefined ? { checker: "v" } : options.checkWork }],
    ["v", { id: "v", name: "Vera" }],
  ]);
  const threads = new Map<string, Line[]>();
  const lines = (threadId: string) => threads.get(threadId) ?? (threads.set(threadId, []), threads.get(threadId)!);
  const timers: Array<{ at: number; run: () => void; off: boolean }> = [];
  const runs: Array<{ botId: string; threadId: string; text: string; kind: "check" | "fix" }> = [];
  const posted: Array<{ name: string; ok: boolean; input: string; output: string }> = [];
  const done: string[] = [];
  const checkerReplies = [...(options.checkerReplies ?? [])], fixes = [...(options.fixes ?? [])];
  let opened = 0;
  const chapter = options.chapter ?? "The door opened. \"Hello,\" she said.";
  lines("chat").push(
    { id: id(), role: "user", kind: "text", text: 'Improve the dialogue, keep every event.\n<attached-file path="/data/attachments/a.md" name="chapter.md" />' },
    { id: id(), role: "bot", kind: "text", text: chapter, turnId: "t1" },
  );
  const host = createCheckWork({
    bot: (botId) => bots.get(botId),
    messages: (threadId) => lines(threadId) as Message[],
    post: (threadId, line) => { posted.push(line); lines(threadId).push({ id: id(), role: "bot", kind: "activity" }); },
    line: (_threadId, key, params) => serverLine("en", key, params),
    openCheck: async (_worker, checker) => ({ botId: checker?.id ?? "w", threadId: `check-${++opened}`, model: "Other model" }),
    run: async (botId, threadId, text, kind, settled) => {
      runs.push({ botId, threadId, text, kind });
      const reply = (kind === "check" ? checkerReplies : fixes).shift() ?? { text: kind === "check" ? "pass" : "Fixed." };
      reply.meanwhile?.();
      if (reply.throws) throw new Error(reply.throws);
      if (reply.ok !== false && reply.text) lines(threadId).push({ id: id(), role: "bot", kind: "text", text: reply.text, turnId: `t${ids}` });
      queueMicrotask(() => settled({ ok: reply.ok !== false, text: reply.text ?? "", ...(reply.failure ? { failure: { text: reply.failure } } : {}) } as HostTurnResult));
    },
    done: (_botId, _threadId, text) => done.push(text),
    now: () => clock,
    timer: (run, ms) => { const timer = { at: clock + ms, run, off: false }; timers.push(timer); return () => { timer.off = true; }; },
  });
  const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((resolve) => setImmediate(resolve)); for (const timer of timers.filter((t) => !t.off && t.at <= clock)) { timer.off = true; timer.run(); } } };
  const advance = async (ms: number) => { clock += ms; await settle(); };
  return { host, runs, posted, done, lines, bots, settle, advance, chapter };
}

describe("readVerdict", () => {
  it("passes only on a first line that says pass or zero issues; anything else is never a pass", () => {
    expect(readVerdict("pass")).toEqual({ kind: "pass" });
    expect(readVerdict("**Pass**\nNothing to report.")).toEqual({ kind: "pass" });
    expect(readVerdict("issues: 0")).toEqual({ kind: "pass" });
    expect(readVerdict("Issues: 3\n1. ...")).toEqual({ kind: "issues", count: 3 });
    for (const unclear of ["", "cannot check: the source is missing", "Looks good to me, pass", "passed with notes"]) expect(readVerdict(unclear)).toEqual({ kind: "unclear" });
  });
});

describe("check before done", () => {
  it("does nothing at all when the setting is off", async () => {
    const f = fixture({ checkWork: null });
    const before = structuredClone(f.lines("chat"));
    expect(f.host.answered("w", "chat", "t1")).toBe(false);
    await f.advance(CHECK_WORK_MAX_MS * 2);
    expect(f.host.holds("chat")).toBe(false);
    expect([f.runs, f.posted, f.done]).toEqual([[], [], []]);
    expect(f.lines("chat")).toEqual(before);
  });

  it("passes on the first round: one check on the named bot, one line, one done", async () => {
    const f = fixture({ checkerReplies: [{ text: "pass" }] });
    expect(f.host.answered("w", "chat", "t1")).toBe(true);
    expect(f.host.holds("chat")).toBe(true);
    await f.settle();
    expect(f.runs.map((run) => [run.botId, run.kind])).toEqual([["v", "check"]]);
    expect(f.runs[0]!.text).toContain('Improve the dialogue, keep every event.\n<attached-file path="/data/attachments/a.md" name="chapter.md" />');
    expect(f.runs[0]!.text).toContain(`<result>\n${f.chapter}\n</result>`);
    expect(f.runs[0]!.text).toContain('The first line of your reply must be exactly "pass"');
    expect(f.posted).toEqual([{ name: "Checked by Vera · passed in round 1", ok: true, input: "Vera · round 1 of 3", output: "pass" }]);
    expect(f.done).toEqual([f.chapter]);
    expect(f.host.holds("chat")).toBe(false);
  });

  it("carries a long chapter to the checker whole", async () => {
    const chapter = "The harbour lights came on one by one. ".repeat(1_100);
    const f = fixture({ chapter });
    f.host.answered("w", "chat", "t1");
    await f.settle();
    expect(chapter.length).toBeGreaterThan(40_000);
    expect(f.runs[0]!.text).toContain(chapter.trim());
  });

  it("sends the issues back to the bot, checks the whole fix again, and passes", async () => {
    const report = "issues: 2\n1. Paragraph 3: the source says she left at dawn; the result says at dusk. Fix: dawn.\n2. Line 12: an added scar.";
    const f = fixture({ checkerReplies: [{ text: report }, { text: "pass" }], fixes: [{ text: "Fixed chapter, dawn, no scar." }] });
    f.host.answered("w", "chat", "t1");
    await f.settle();
    expect(f.runs.map((run) => [run.botId, run.kind])).toEqual([["v", "check"], ["w", "fix"], ["v", "check"]]);
    expect(f.runs[1]).toMatchObject({ threadId: "chat" });
    expect(f.runs[1]!.text).toContain("Fix exactly these and nothing else");
    expect(f.runs[1]!.text).toContain(report);
    expect(f.runs[2]!.text).toContain("<result>\nFixed chapter, dawn, no scar.\n</result>");
    expect(f.runs[2]!.text).toContain(`<earlier-report>\n${report}\n</earlier-report>`);
    expect(f.posted.map((line) => [line.name, line.ok])).toEqual([
      ["Vera found 2 issues · fixing them, round 1 of 3", true],
      ["Checked by Vera · passed in round 2", true],
    ]);
    expect(f.done).toEqual(["Fixed chapter, dawn, no scar."]);
  });

  it("stops after three rounds that never pass, with what is still open and the last report", async () => {
    const f = fixture({ checkerReplies: [{ text: "issues: 2\n1. a\n2. b" }, { text: "issues: 1\n1. b" }, { text: "issues: 1\n1. still b" }], fixes: [{ text: "Fix one." }, { text: "Fix two." }] });
    f.host.answered("w", "chat", "t1");
    await f.settle();
    expect(f.runs.map((run) => run.kind)).toEqual(["check", "fix", "check", "fix", "check"]);
    expect(f.posted.at(-1)).toEqual({ name: "Checked by Vera · 1 issue still open after 3 rounds", ok: false, input: "Vera · round 3 of 3", output: "issues: 1\n1. still b" });
    expect(f.done).toEqual(["Fix two."]);
    expect(f.host.holds("chat")).toBe(false);
  });

  it.each([
    ["the checker's model fails", { checkerReplies: [{ ok: false, failure: "the model is overloaded" }] }, "Not checked: Vera stopped: the model is overloaded"],
    ["the checker is refused by a usage limit", { checkerReplies: [{ throws: "This bot reached its usage limit" }] }, "Not checked: Vera could not start: This bot reached its usage limit"],
    ["the checker answers without a verdict", { checkerReplies: [{ text: "I can't do that." }] }, "Not checked: Vera's reply did not start with pass or issues"],
    ["the fix fails", { checkerReplies: [{ text: "issues: 1\n1. x" }], fixes: [{ ok: false, failure: "stopped" }] }, "Not checked: the fix did not finish: stopped"],
  ])("delivers the answer as not checked when %s", async (_case, options, line) => {
    const f = fixture(options);
    f.host.answered("w", "chat", "t1");
    await f.settle();
    expect(f.posted.at(-1)).toMatchObject({ name: line, ok: false });
    expect(f.done).toEqual([f.chapter]);
    expect(f.host.holds("chat")).toBe(false);
  });

  it("delivers as not checked when the named checker was removed, or when the checks run past their time", async () => {
    const gone = fixture();
    gone.bots.delete("v");
    gone.host.answered("w", "chat", "t1");
    await gone.settle();
    expect(gone.runs).toEqual([]);
    expect(gone.posted).toMatchObject([{ name: "Not checked: the bot chosen to check was removed", ok: false }]);

    const slow = fixture();
    let settledLater: ((outcome: HostTurnResult) => void) | undefined;
    const hung = createCheckWork({ ...Object.fromEntries([]), bot: (id) => slow.bots.get(id), messages: (threadId) => slow.lines(threadId) as Message[], post: (_t, line) => slow.posted.push(line),
      line: (_t, key, params) => serverLine("en", key, params), openCheck: async () => ({ botId: "v", threadId: "check-1", model: "m" }),
      run: async (_b, _t, _x, _k, settled) => { settledLater = settled; }, done: (_b, _t, text) => slow.done.push(text), now: () => 0,
      timer: (run, ms) => { const t = setTimeout(run, ms === 0 ? 0 : 5); return () => clearTimeout(t); } });
    hung.answered("w", "chat", "t1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slow.posted).toMatchObject([{ name: "Not checked: the checks took more than 30 minutes", ok: false }]);
    settledLater?.({ ok: true, text: "pass" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(slow.posted).toHaveLength(1);
    expect(slow.done).toEqual([slow.chapter]);
  });

  it("checks on a thread of the bot's own when no checker is named, and stops when the person writes again", async () => {
    const own = fixture({ checkWork: {} });
    own.host.answered("w", "chat", "t1");
    await own.settle();
    expect(own.runs.map((run) => run.botId)).toEqual(["w"]);
    expect(own.runs[0]!.threadId).toBe("check-1");
    expect(own.posted[0]!.name).toBe("Checked by a thread of its own on Other model · passed in round 1");

    const moved = fixture({ checkerReplies: [{ text: "issues: 1\n1. x", meanwhile: () => moved.lines("chat").push({ id: "new", role: "user", kind: "text", text: "Actually, stop." }) }] });
    moved.host.answered("w", "chat", "t1");
    await moved.settle();
    expect(moved.runs.map((run) => run.kind)).toEqual(["check"]);
    expect(moved.posted.at(-1)).toMatchObject({ name: "Not checked: you sent a new message", ok: false });
  });
});
