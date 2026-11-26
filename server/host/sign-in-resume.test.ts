import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import type { Message } from "../store.ts";
import { createSignInResume, createSignInResumeHost, RECHECK_MS, RECHECKS_UNANSWERED, RESUME_WINDOW_MS, type SignInResumeDeps, type SignInWait } from "./sign-in-resume.ts";

const claude: ModelSelection = { instanceId: "claude", model: "sonnet" };
const scratch: string[] = [];
afterEach(() => { while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true }); });

function world(options: { file?: string } = {}) {
  let clock = 1_000;
  const paths = new Map<string, Message[]>();
  const offBranch = new Map<string, Message[]>();
  const models = new Map<string, ModelSelection>();
  const busy = new Set<string>();
  let full = false;
  let signedIn = true;
  let probe: Promise<boolean> | null = null;
  let readStarted: (() => void) | undefined;
  const timers: Array<() => void> = [];
  const sent: Array<{ wait: SignInWait; message: Message }> = [];
  let nextId = 0;
  const row = (threadId: string, fields: Partial<Message>): Message => {
    const path = paths.get(threadId) ?? [];
    const message = { id: `m${nextId++}`, role: "bot", kind: "activity", at: clock, parentId: path.at(-1)?.id ?? null, ...fields } as Message;
    paths.set(threadId, [...path, message]);
    return message;
  };
  const deps: SignInResumeDeps = {
    ...(options.file ? { file: options.file } : {}),
    store: {
      activePath: (threadId: string) => paths.get(threadId) ?? [],
      messagesFor: (threadId: string) => [...(paths.get(threadId) ?? []), ...(offBranch.get(threadId) ?? [])],
      taskByThread: (_botId: string, threadId: string) => (paths.has(threadId) ? { threadId } : undefined),
      projectBotForTask: (_botId: string, threadId: string) => (paths.has(threadId) ? { modelSelection: models.get(threadId) ?? claude } : null),
      patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
        const path = paths.get(threadId)!;
        const at = path.findIndex((message) => message.id === id);
        path[at] = { ...path[at]!, ...patch };
        return path[at]!;
      },
    } as unknown as SignInResumeDeps["store"],
    signedInNow: async () => {
      readStarted?.();
      return (probe ? await probe : signedIn) ? () => true : null;
    },
    engineName: () => "Claude",
    busy: (_botId, threadId) => busy.has(threadId),
    atCapacity: () => full,
    retry: async (wait, message) => {
      sent.push({ wait, message });
      return row(wait.threadId, { role: "user", kind: "text", text: message.text });
    },
    now: () => clock,
    after: (_ms, run) => { timers.push(run); },
    log: () => {},
  };
  /** A conversation whose last message met the AI signed out: the failed row, its notice, the digest. */
  const stuck = (threadId: string, text = "Draft the plan") => {
    row(threadId, { role: "bot", kind: "text", text: "Hi, I'm Kai." });
    const asked = row(threadId, { role: "user", kind: "text", text });
    row(threadId, { tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true } });
    const notice = row(threadId, { tool: { name: "notice: Claude is signed out on this computer.", ok: true, setup: true } });
    row(threadId, { kind: "digest", text: "turn failed" });
    const wait: SignInWait = { botId: "kai", threadId, messageId: asked.id, selection: claude, failedAt: clock };
    return { asked, notice, wait, noticed: { instanceId: "claude", threadId, messageId: notice.id, at: notice.at } };
  };
  return {
    deps, sent, paths, offBranch, models, busy, row, stuck, timers,
    tick: (ms: number) => { clock += ms; },
    set full(value: boolean) { full = value; },
    set signedIn(value: boolean) { signedIn = value; },
    reading: () => new Promise<void>((resolve) => { readStarted = resolve; }),
    hold: () => { let release!: (value: boolean) => void; probe = new Promise((resolve) => { release = resolve; }); return (value: boolean) => { probe = null; release(value); }; },
    noticeTool: (threadId: string, id: string) => paths.get(threadId)!.find((message) => message.id === id)!.tool,
  };
}

describe("createSignInResume", () => {
  it("sends each waiting message again once its AI is signed in, and says so on its notice", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai"), rosa = w.stuck("t-rosa", "Draft the budget");
    resume.waiting(kai.wait); resume.noticed(kai.noticed);
    resume.waiting({ ...rosa.wait, botId: "rosa" }); resume.noticed(rosa.noticed);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent.map(({ message }) => message.text)).toEqual(["Draft the plan", "Draft the budget"]);
    expect(w.noticeTool("t-kai", kai.notice.id)).toEqual({ name: "notice: Claude is signed in again.", nameCode: "chat.notice.signedInAgain", nameParams: { engine: "Claude" }, ok: true });
    await resume.signedIn("claude");
    expect(w.sent, "a second sign-in event has nothing left to send").toHaveLength(2);
  });

  it("does nothing while the AI itself does not say it is signed in, and acts on the next sign-in", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait); resume.noticed(kai.noticed);
    w.signedIn = false;
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
    expect(w.noticeTool("t-kai", kai.notice.id)?.setup).toBe(true);
    w.signedIn = true;
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toHaveLength(1);
  });

  it.each([
    ["the conversation is working", (w: ReturnType<typeof world>) => { w.busy.add("t-kai"); }],
    ["the person wrote again", (w: ReturnType<typeof world>) => { w.row("t-kai", { role: "user", kind: "text", text: "never mind" }); }],
    ["the bot already answered", (w: ReturnType<typeof world>) => { w.row("t-kai", { role: "bot", kind: "text", text: "Here is the plan." }); }],
    ["the person started fresh", (w: ReturnType<typeof world>) => { w.row("t-kai", { kind: "compaction", compaction: { fresh: true } } as Partial<Message>); }],
    ["the conversation moved to another model of the same AI", (w: ReturnType<typeof world>) => { w.models.set("t-kai", { ...claude, model: "opus" }); }],
    ["the conversation moved to another AI", (w: ReturnType<typeof world>) => { w.models.set("t-kai", { instanceId: "codex", model: "gpt" }); }],
  ])("leaves the message alone when %s, and still says the AI is signed in again", async (_why, change) => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait); resume.noticed(kai.noticed);
    change(w);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
    expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain");
  });

  it("never sends a spoken line again", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    w.paths.get("t-kai")!.find((message) => message.id === kai.asked.id)!.via = "call";
    resume.waiting(kai.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it("a message sent again that meets a sign-out again waits for the next sign-in, not the one that sent it", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toHaveLength(1);
    w.tick(5);
    w.row("t-kai", { tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true } });
    const resent = w.paths.get("t-kai")!.findLast((message) => message.role === "user")!;
    await resume.waiting({ ...kai.wait, messageId: resent.id, failedAt: 1_015 });
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent.map(({ message }) => message.id), "a sign-in after the second refusal takes it up").toEqual([kai.asked.id, resent.id]);
  });

  it("leaves a message the person sent again on another version meanwhile", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait);
    w.tick(5);
    w.offBranch.set("t-kai", [{ id: "retried", role: "user", kind: "text", text: "Draft the plan", at: 1_005, parentId: null } as Message]);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it("leaves a message whose conversation was started fresh on another version meanwhile", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait);
    w.offBranch.set("t-kai", [{ id: "fresh", role: "bot", kind: "compaction", compaction: { fresh: true }, at: 1_005, parentId: null } as Message]);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it.each([
    ["a reaction", (_w: ReturnType<typeof world>, asked: Message) => { asked.reaction = "👍"; }],
    ["a press on a widget", (w: ReturnType<typeof world>, asked: Message) => {
      const widget = w.paths.get("t-kai")!.find((message) => message.role === "bot" && message.kind === "text")!;
      widget.widget = { kind: "buttons" } as never;
      asked.replyToId = widget.id;
    }],
  ])("never sends %s again as plain words", async (_what, mark) => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    mark(w, w.paths.get("t-kai")!.find((message) => message.id === kai.asked.id)!);
    resume.waiting(kai.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it("asks again for a notice alone, when the status read does not say signed in", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.noticed(kai.noticed);
    w.signedIn = false;
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.timers).toHaveLength(1);
    w.signedIn = true;
    w.timers.shift()!();
    await vi.waitFor(() => expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain"));
  });

  it("keeps one recheck for an AI however many sign-in events come", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    resume.waiting(w.stuck("t-kai").wait);
    w.signedIn = false;
    w.tick(10);
    await resume.signedIn("claude");
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.timers).toHaveLength(1);
  });

  it("never sends a line an app wrote", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    w.paths.get("t-kai")!.find((message) => message.id === kai.asked.id)!.fromApp = { title: "Planner" } as never;
    resume.waiting(kai.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it("asks again a few times when the AI's status does not say it is signed in, then waits for the next sign-in", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    resume.waiting(w.stuck("t-kai").wait);
    w.signedIn = false;
    w.tick(10);
    await resume.signedIn("claude");
    let reads = 1;
    while (w.timers.length) {
      expect(w.timers).toHaveLength(1);
      w.timers.shift()!();
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(reads, "five reads in all, then it waits for a sign-in").toBe(RECHECKS_UNANSWERED);
    w.signedIn = true;
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toHaveLength(1);
  });

  it("answers a sign-in only with what was left before it: a sign-out met during its status read waits for the next one", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const rosa = w.stuck("t-rosa", "Draft the budget");
    resume.waiting({ ...rosa.wait, botId: "rosa" });
    const reading = w.reading();
    const release = w.hold();
    w.tick(10);
    const pass = resume.signedIn("claude");
    await reading;
    w.tick(10);
    const later = w.stuck("t-kai");
    resume.waiting(later.wait); resume.noticed(later.noticed);
    release(true);
    await pass;
    expect(w.sent.map(({ message }) => message.text)).toEqual(["Draft the budget"]);
    expect(w.noticeTool("t-kai", later.notice.id)?.setup, "the new notice still offers Sign in").toBe(true);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent.map(({ message }) => message.text)).toEqual(["Draft the budget", "Draft the plan"]);
  });

  it("stops sending when the AI's instance is replaced partway through a pass, and reads the new one", async () => {
    const w = world();
    let current = true;
    const resume = createSignInResume({ ...w.deps, signedInNow: async () => () => current, retry: async (wait, message) => { w.sent.push({ wait, message }); current = false; } });
    resume.waiting(w.stuck("t-kai").wait);
    resume.waiting({ ...w.stuck("t-rosa", "Draft the budget").wait, botId: "rosa" });
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toHaveLength(1);
    expect(w.timers, "a new pass reads the instance now there").toHaveLength(1);
    current = true;
    w.timers.shift()!();
    await vi.waitFor(() => expect(w.sent.map(({ message }) => message.text)).toEqual(["Draft the plan", "Draft the budget"]));
  });

  it("leaves a refusal told in the same millisecond as a sign-in for the next sign-in", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    const pass = resume.signedIn("claude");
    resume.waiting(kai.wait);
    await pass;
    expect(w.sent).toEqual([]);
  });

  it("takes up a message the sign-in came before, once its turn has settled", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    w.tick(10);
    await resume.signedIn("claude");
    await resume.waiting(kai.wait);
    expect(w.sent).toHaveLength(1);
  });

  it("keeps the newer of two messages of one conversation, whichever is told last", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const first = w.stuck("t-kai", "first");
    w.tick(5);
    const second = w.stuck("t-kai", "second");
    resume.waiting(second.wait);
    resume.waiting(first.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent.map(({ message }) => message.text)).toEqual(["second"]);
    expect(w.noticeTool("t-kai", first.notice.id)?.setup, "unrecorded notices are left as they are").toBe(true);
  });

  it("waits for room when its bot has none, and sends it once there is", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait);
    w.full = true;
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
    expect(w.timers).toHaveLength(1);
    w.full = false;
    w.tick(RECHECK_MS);
    w.timers.shift()!();
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
  });

  it("forgets a message left longer than the resume window, but still rewrites its notice", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.waiting(kai.wait); resume.noticed(kai.noticed);
    w.tick(RESUME_WINDOW_MS + 1);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
    expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain");
  });

  it("rewrites a notice on another version of the conversation too", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    resume.noticed(kai.noticed);
    const path = w.paths.get("t-kai")!;
    w.offBranch.set("t-kai", path.filter((message) => message.id === kai.notice.id));
    w.paths.set("t-kai", path.filter((message) => message.id !== kai.notice.id));
    w.deps.store.patchMessage = (threadId, _id, patch) => {
      const rows = w.offBranch.get(threadId)!;
      rows[0] = { ...rows[0]!, ...patch };
      return rows[0]!;
    };
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.offBranch.get("t-kai")![0]!.tool?.nameCode).toBe("chat.notice.signedInAgain");
  });

  it("checks less often while its bot stays full", async () => {
    const w = world();
    const delays: number[] = [];
    const resume = createSignInResume({ ...w.deps, after: (ms, run) => { delays.push(ms); w.timers.push(run); } });
    resume.waiting(w.stuck("t-kai").wait);
    w.full = true;
    w.tick(10);
    await resume.signedIn("claude");
    for (let round = 0; round < 3; round += 1) {
      w.timers.shift()!();
      await vi.waitFor(() => expect(delays).toHaveLength(round + 2));
    }
    expect(delays).toEqual([RECHECK_MS, RECHECK_MS * 2, RECHECK_MS * 4, RECHECK_MS * 8]);
  });

  it("never sends a line a bot relayed in the person's name", async () => {
    const w = world();
    const resume = createSignInResume(w.deps);
    const kai = w.stuck("t-kai");
    w.paths.get("t-kai")!.find((message) => message.id === kai.asked.id)!.relayed = true as never;
    resume.waiting(kai.wait);
    w.tick(10);
    await resume.signedIn("claude");
    expect(w.sent).toEqual([]);
  });

  it("starts with what it can read of a damaged saved file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-sign-in-resume-"));
    scratch.push(directory);
    const file = join(directory, "sign-in-resume.json");
    const w = world({ file });
    const kai = w.stuck("t-kai");
    writeFileSync(file, JSON.stringify({ waiting: [null, { botId: "kai" }, kai.wait], notices: [7, kai.noticed] }));
    w.tick(10);
    const resume = createSignInResume(w.deps);
    await resume.resumeSaved();
    expect(w.sent.map(({ message }) => message.id)).toEqual([kai.asked.id]);
    expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain");
    const logged: string[] = [];
    for (const damaged of ["[1, 2]", "{not json"]) {
      writeFileSync(file, damaged);
      expect(() => createSignInResume({ ...w.deps, log: (line) => logged.push(line) })).not.toThrow();
    }
    expect(logged).toEqual([expect.stringContaining("not an object"), expect.stringContaining("could not read the saved file")]);
  });

  function hostWorld() {
    const directory = mkdtempSync(join(tmpdir(), "omb-sign-in-resume-"));
    scratch.push(directory);
    const w = world();
    const sawSignedIn = vi.fn();
    const listeners: Array<(instanceId: string) => void> = [];
    const instance = { snapshot: async () => ({ state: "available" as const, authenticated: true }) };
    const takeover = { signedIn: vi.fn() };
    const host = createSignInResumeHost({
      ...w.deps, dataDir: directory, takeover, startupRead: null,
      registry: {
        forgetSnapshots: () => {},
        get: () => instance as never,
        onSignedIn: (listener) => { listeners.push(listener); },
        sawSignedIn,
      },
      startTurn: async (_botId, text, opts) => {
        const sent = w.row(opts.threadId, { role: "user", kind: "text", text });
        w.sent.push({ wait: { threadId: opts.threadId } as SignInWait, message: sent });
        return sent;
      },
      replyTarget: () => undefined,
    });
    return { w, host, takeover, sawSignedIn, listeners };
  }

  it("runs a pass for a sign-in made in the app, and marks it so the status read that finds it tells nothing more", async () => {
    const { w, host, takeover, sawSignedIn } = hostWorld();
    const kai = w.stuck("t-kai");
    host.waiting(kai.wait); host.noticed(kai.noticed);
    w.tick(10);
    host.appSignedIn("claude");
    expect(sawSignedIn).toHaveBeenCalledWith("claude");
    expect(takeover.signedIn).toHaveBeenCalledWith("claude");
    await vi.waitFor(() => expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain"));
    expect(w.sent.map(({ message }) => message.text)).toEqual(["Draft the plan"]);
  });

  it("takes a sign-in made in the app after a status read already told one for a new sign-in", async () => {
    const { w, host, listeners } = hostWorld();
    w.tick(10);
    listeners.forEach((listener) => listener("claude"));
    w.tick(10);
    const kai = w.stuck("t-kai");
    host.noticed(kai.noticed);
    w.tick(10);
    host.appSignedIn("claude");
    await vi.waitFor(() => expect(w.noticeTool("t-kai", kai.notice.id)?.nameCode).toBe("chat.notice.signedInAgain"));
  });

  it("after a restart, asks the AI once and sends what was left waiting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-sign-in-resume-"));
    scratch.push(directory);
    const file = join(directory, "sign-in-resume.json");
    const w = world({ file });
    const kai = w.stuck("t-kai");
    createSignInResume(w.deps).waiting(kai.wait);
    w.tick(10);
    const restarted = createSignInResume(w.deps);
    await restarted.resumeSaved();
    expect(w.sent.map(({ message }) => message.id)).toEqual([kai.asked.id]);
  });
});
