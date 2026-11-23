import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCoordinator, type Coordinator, type CoordinateBotsCall, type CoordinatorHost, type HandoffView } from "../coordinator.ts";
import type { RemoteResult, RemoteTeammate } from "../remote-teammates.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createRemoteHandoff, REMOTE_REWORK_MAX, remoteBotId, type RemoteHandoffContext, type RemoteHandoffDeps } from "./remote-teammate-handoff.ts";

const ADA: RemoteTeammate = { id: "6f1c1a52-9d55-4b8e-9d0e-6c1f0b0f2a11", name: "Ada", base: "https://bots.example.test", botId: "ada-bot", key: "bak_testkeytestkeytestkey", createdAt: 1 };
const REMOTE = remoteBotId(ADA.id);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

function innerHost(): CoordinatorHost {
  return {
    validate: vi.fn(() => undefined),
    busy: vi.fn(() => false),
    run: vi.fn(async () => ({ ok: true, text: "local done" })),
    report: vi.fn(),
    changed: vi.fn(),
    names: vi.fn(() => ({ requester: "Chief", assignee: "Local" })),
    park: vi.fn(),
    levelOf: vi.fn(() => ({ level: "ask" as const })),
    chiefOf: vi.fn(() => false),
  };
}

function setup(more: Partial<RemoteHandoffDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remote-handoff-"));
  dirs.push(dir);
  const teammates = [ADA];
  let coordinator: Coordinator | undefined;
  const progress = vi.fn();
  const deps: RemoteHandoffDeps = {
    teammates: { list: () => teammates.map(({ key: _key, ...view }) => view), get: (id) => teammates.find((one) => one.id === id) },
    coordinator: () => coordinator!,
    localBots: () => [{ id: "chief-id", name: "Chief" }, { id: "local-ada-twin", name: "Builder" }],
    botName: (id) => (id === "chief-id" ? "Chief" : undefined),
    outside: () => undefined,
    file: join(dir, "remote-teammate-work.json"),
    wait: vi.fn(async () => {}),
    log: () => {},
    ...more,
  };
  const remote = createRemoteHandoff(deps);
  const inner = innerHost();
  const host = remote.host(inner);
  coordinator = createCoordinator({ dataDir: dir, host, log: () => {} });
  const realProgress = coordinator.progress.bind(coordinator);
  coordinator.progress = (threadId) => { progress(threadId); realProgress(threadId); };
  coordinator.beginTurn({ id: "gen-1", address: { botId: "chief-id", threadId: "chief-chat" }, brief: "Ask Ada", level: "full", origin: { kind: "user", request: "Ask Ada" } });
  const context: RemoteHandoffContext = { sender: { id: "chief-id", name: "Chief" }, address: { threadId: "chief-chat", botId: "chief-id" }, generation: "gen-1", external: false, handed: vi.fn() };
  return { dir, deps, remote, inner, host, coordinator, context, progress, teammates };
}

const call = (botIds: string[], more: Partial<CoordinateBotsCall> = {}): CoordinateBotsCall => ({ botIds, message: "Check the staging site", rework: false, thread: "standing", reply: "resume", consult: false, ...more });
const local = vi.fn(async (sent: CoordinateBotsCall) => ({ status: 200, body: { receipts: sent.botIds.map((botId) => ({ botId, outcome: "queued", detail: "sent here" })), message: "Local sent." } }));
const reply = (text: string, thread = "t-1"): RemoteResult => ({ ok: true, answer: { reply: text, thread } });
const working = (status: "working" | "needs_approval" = "working", thread = "t-1"): RemoteResult => ({ ok: true, answer: { thread, status } });

/** Hands Ada the work and returns her node, as the coordinator would run it. */
function handed(s: ReturnType<typeof setup>, more: Partial<CoordinateBotsCall> = {}) {
  const { node } = s.coordinator.enqueue(s.context.address, "gen-1", undefined, { botId: REMOTE, threadId: `${REMOTE}:chief-chat` }, "Check the staging site",
    { mode: more.consult ? "consult" : more.reply === "none" ? "notify" : "work", reply: more.reply === "none" ? "none" : "resume" });
  return node;
}
const run = (s: ReturnType<typeof setup>, node: HandoffView, signal = new AbortController().signal) =>
  s.host.run(node, false, signal, { text: node.text, note: "", restartNote: "", turn: "first" });

describe("remote teammate hand-off: list_bots and coordinate_bots", () => {
  it("lists each teammate on another server by its address here, with no key", () => {
    const { remote } = setup();
    const agents = remote.agents();
    expect(agents).toEqual([{ id: REMOTE, name: "Ada", section: "", model: "", busy: false, status: "remote", statusText: "on another server (bots.example.test)" }]);
    expect(JSON.stringify(agents)).not.toContain("bak_");
  });

  it("queues work for a teammate named by its address or its name, and hands the rest to this server's bots", async () => {
    const s = setup();
    local.mockClear();
    const result = await s.remote.coordinate(call([REMOTE, "Builder"]), s.context, local);
    expect(result.status).toBe(200);
    expect(local).toHaveBeenCalledWith(expect.objectContaining({ botIds: ["Builder"] }));
    const receipts = result.body.receipts as Array<{ botId: string; outcome: string; requestId?: string; detail: string }>;
    expect(receipts[0]).toMatchObject({ botId: REMOTE, outcome: "queued", detail: expect.stringContaining("sent to Ada on another server") });
    expect(s.coordinator.node(receipts[0]!.requestId!)).toMatchObject({ botId: REMOTE, parentId: "gen-1", status: "queued", mode: "work", reply: "resume" });
    expect(s.context.handed).toHaveBeenCalledWith(receipts[0]!.requestId);

    const byName = await s.remote.coordinate(call(["ada"], { consult: true }), s.context, local);
    expect((byName.body.receipts as Array<{ botId: string }>)[0]!.botId).toBe(REMOTE);
  });

  it("leaves a name one of this server's bots answers to, and calls from outside this server's turns, to this server", async () => {
    const s = setup();
    s.teammates.push({ ...ADA, id: "0d7e2f43-1b2c-4c8d-8e9f-0a1b2c3d4e5f", name: "Chief" });
    local.mockClear();
    await s.remote.coordinate(call(["Chief"]), s.context, local);
    expect(local).toHaveBeenCalledWith(expect.objectContaining({ botIds: ["Chief"] }));
    local.mockClear();
    await s.remote.coordinate(call([REMOTE]), { ...s.context, external: true }, local);
    expect(local).toHaveBeenCalledWith(expect.objectContaining({ botIds: [REMOTE] }));
    expect(s.coordinator.children("gen-1")).toEqual([]);
  });

  it("takes a short name as an id start of this server's bots only at 8 characters, as anywhere else", async () => {
    const s = setup();
    s.teammates.push({ ...ADA, id: "0d7e2f43-1b2c-4c8d-8e9f-0a1b2c3d4e5f", name: "Loc" });
    local.mockClear();
    await s.remote.coordinate(call(["Loc"]), s.context, local);
    expect(local).not.toHaveBeenCalled();
    expect(s.coordinator.children("gen-1")).toHaveLength(1);
    expect(s.remote.resolve("local-ad")).toBeUndefined();
    expect(s.remote.resolve("LOCAL-ADA-TWIN")).toBeUndefined();
  });

  it("refuses rooms, answers, posts, consult without a reply, and work that came in from outside", async () => {
    const outside = "This work came in from outside, so it stays in this conversation.";
    const s = setup({ outside: (threadId) => (threadId === "guest-chat" ? outside : undefined) });
    local.mockClear();
    const cases: Array<[CoordinateBotsCall, RemoteHandoffContext, string]> = [
      [call([REMOTE]), { ...s.context, address: { ...s.context.address, groupId: "room-1" } }, "in no room here"],
      [call([REMOTE], { answers: "a-1" }), s.context, "plain work or a question"],
      [call([REMOTE], { post: { deliveryId: "d", wake: true } }), s.context, "plain work or a question"],
      [call([REMOTE], { consult: true, reply: "none" }), s.context, "leave reply out"],
      [call([REMOTE]), { ...s.context, address: { ...s.context.address, threadId: "guest-chat" } }, "came in from outside"],
      [call([REMOTE]), { ...s.context, problem: "Your task is gone." }, "Your task is gone."],
    ];
    for (const [sent, context, said] of cases) {
      const result = await s.remote.coordinate(sent, context, local);
      expect(result.status).toBe(409);
      expect(result.body.error).toContain(said);
    }
    expect(local).not.toHaveBeenCalled();
    expect(s.coordinator.children("gen-1")).toEqual([]);
  });

  it("says files stay here, since they do not reach another server", async () => {
    const s = setup();
    const result = await s.remote.coordinate(call([REMOTE], { files: [{ kind: "file", path: "/tmp/a.txt", name: "a.txt", mime: "text/plain", bytes: 3 }] }), s.context, local);
    expect((result.body.receipts as Array<{ detail: string }>)[0]!.detail).toContain("files were not sent");
  });
});

describe("remote teammate hand-off: the teammate's turn", () => {
  it("sends the work once with who asks, and its reply comes back as information, never the person's approval", async () => {
    const send = vi.fn(async () => reply("Staging is up."));
    const s = setup({ send });
    const node = handed(s);
    const result = await run(s, node);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Staging is up.");
    expect(result.text).toContain("never the person's approval");
    expect(send).toHaveBeenCalledTimes(1);
    const [teammate, sent] = send.mock.calls[0]! as unknown as [RemoteTeammate, { message: string; wait: number }];
    expect(teammate.id).toBe(ADA.id);
    expect(sent.message).toContain("Chief, a bot on another OpenMausBot server, hands you this work");
    expect(sent.message).toContain("Check the staging site");
    expect(sent.wait).toBe(50);
  });

  it("keeps the whole brief within the Bot API's message limit", async () => {
    const send = vi.fn(async () => reply("ok"));
    const s = setup({ send });
    const node = handed(s);
    await run(s, { ...node, text: "x".repeat(25_000) });
    const [, sent] = send.mock.calls[0]! as unknown as [RemoteTeammate, { message: string }];
    expect(sent.message.length).toBeLessThanOrEqual(20_000);
    expect(sent.message).toContain("Chief, a bot on another OpenMausBot server");
  });

  it("never sends a secret the brief carries to the other server", async () => {
    const send = vi.fn(async () => reply("ok"));
    const s = setup({ send });
    const { node } = s.coordinator.enqueue(s.context.address, "gen-1", undefined, { botId: REMOTE, threadId: `${REMOTE}:chief-chat` }, "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to deploy");
    await run(s, node);
    expect((send.mock.calls[0] as unknown as [RemoteTeammate, { message: string }])[1].message).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("reads the thread at a widening pause while the teammate works, keeping the turn alive, until the reply is there", async () => {
    const send = vi.fn(async () => working());
    const read = vi.fn<() => Promise<RemoteResult>>().mockResolvedValueOnce(working()).mockResolvedValueOnce(working()).mockResolvedValueOnce(reply("Done."));
    const wait = vi.fn(async () => {});
    const s = setup({ send, read, wait });
    const result = await run(s, handed(s));
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining("Done.") });
    expect(send).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every((args) => (args as unknown[])[1] === "t-1")).toBe(true);
    expect(wait.mock.calls.map((args) => (args as unknown[])[0])).toEqual([30_000, 60_000, 120_000]);
    expect(s.progress).toHaveBeenCalledTimes(3);
  });

  it("ends with a plain result when the teammate waits on its owner's approval", async () => {
    const s = setup({ send: vi.fn(async () => working("needs_approval")) });
    const result = await run(s, handed(s));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("stopped to ask its owner for an approval");
  });

  it("does not wait for a one-way notice", async () => {
    const send = vi.fn(async () => working());
    const s = setup({ send });
    const result = await run(s, handed(s, { reply: "none" }));
    expect(result).toEqual({ ok: true, text: "Delivered to Ada on another server." });
    expect((send.mock.calls[0] as unknown[])[1]).toMatchObject({ wait: 0 });
  });

  it("waits the other server's retry-after when it is busy or rate limited, then sends", async () => {
    const send = vi.fn<() => Promise<RemoteResult>>()
      .mockResolvedValueOnce({ ok: false, problem: "rate_limited", status: 429, retryAfterSeconds: 42 })
      .mockResolvedValueOnce({ ok: false, problem: "busy", status: 409 })
      .mockResolvedValueOnce(reply("ok"));
    const wait = vi.fn(async () => {});
    const s = setup({ send, wait });
    expect((await run(s, handed(s))).ok).toBe(true);
    expect(wait.mock.calls.map((args) => (args as unknown[])[0])).toEqual([42_000, 30_000]);
  });

  it("never sends again after a send that may have arrived, and fails plainly on a refused key", async () => {
    const unreachable = vi.fn(async (): Promise<RemoteResult> => ({ ok: false, problem: "unreachable", detail: "no answer in time" }));
    const s = setup({ send: unreachable });
    const first = await run(s, handed(s));
    expect(first).toMatchObject({ ok: false, failure: { text: expect.stringContaining("could not be reached") } });
    expect(unreachable).toHaveBeenCalledTimes(1);

    const wrongKey = vi.fn(async (): Promise<RemoteResult> => ({ ok: false, problem: "wrong_key", status: 401 }));
    const t = setup({ send: wrongKey });
    const second = await run(t, handed(t));
    expect(second).toMatchObject({ ok: false, text: expect.stringContaining("no longer takes the saved key") });
    expect(second.text).not.toContain("bak_");
    expect(wrongKey).toHaveBeenCalledTimes(1);
  });

  it("gives up on a thread it cannot read after five misses in a row", async () => {
    const read = vi.fn(async (): Promise<RemoteResult> => ({ ok: false, problem: "unreachable" }));
    const s = setup({ send: vi.fn(async () => working()), read });
    const result = await run(s, handed(s));
    expect(result.ok).toBe(false);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("after a restart reads the thread it already sent instead of sending the work again, and forgets it once reported", async () => {
    const s = setup({ send: vi.fn(async () => working()), read: vi.fn(async () => { throw new Error("stop here"); }) });
    const node = handed(s);
    await expect(run(s, node)).rejects.toThrow("stop here");
    const kept = JSON.parse(readFileSync(s.deps.file, "utf8"));
    expect(kept.work[node.id]).toMatchObject({ teammate: ADA.id, thread: "t-1" });
    if (process.platform !== "win32") expect(statSync(s.deps.file).mode & 0o777).toBe(0o600);

    const send = vi.fn(async () => reply("never"));
    const read = vi.fn(async () => reply("Read after the restart."));
    const again = createRemoteHandoff({ ...s.deps, send, read }).host(innerHost());
    const result = await again.run(node, true, new AbortController().signal, { text: "", note: "", restartNote: "", turn: "rerun" });
    expect(result.text).toContain("Read after the restart.");
    expect(send).not.toHaveBeenCalled();
    again.report({ ...node, status: "completed" }, s.coordinator.node("gen-1"));
    expect(JSON.parse(readFileSync(s.deps.file, "utf8")).work[node.id]).toBeUndefined();
  });

  it("goes on in the same conversation there for standing work, and starts a new one for a new thread", async () => {
    const send = vi.fn(async (_teammate: RemoteTeammate, sent: { thread?: string }) => reply("Done.", sent.thread ?? `t-${send.mock.calls.length}`));
    const s = setup({ send });
    const enqueue = (text: string, threadId = `${REMOTE}:chief-chat`) => s.coordinator.enqueue(s.context.address, "gen-1", undefined, { botId: REMOTE, threadId }, text).node;
    await run(s, enqueue("First"));
    await run(s, enqueue("Follow up on that"));
    const threads = () => send.mock.calls.map(([, sent]) => (sent as { thread?: string }).thread);
    expect(threads()).toEqual([undefined, "t-1"]);
    // A restart keeps the conversation.
    const again = createRemoteHandoff({ ...s.deps, send }).host(innerHost());
    await again.run(enqueue("And again"), false, new AbortController().signal, { text: "", note: "", restartNote: "", turn: "first" });
    expect(threads()).toEqual([undefined, "t-1", "t-1"]);

    await s.remote.coordinate(call([REMOTE], { thread: "new", message: "Something else" }), s.context, local);
    const fresh = s.coordinator.children("gen-1").find((node) => node.text === "Something else")!;
    await run(s, fresh);
    expect(threads()).toEqual([undefined, "t-1", "t-1", undefined]);
  });

  it("starts a new conversation there when the other server no longer has the standing one", async () => {
    const send = vi.fn(async (_teammate: RemoteTeammate, sent: { thread?: string }): Promise<RemoteResult> =>
      (sent.thread === "t-1" && send.mock.calls.length > 1 ? { ok: false, problem: "no_thread", status: 404 } : reply("Done.", sent.thread ?? `t-${send.mock.calls.length}`)));
    const s = setup({ send });
    const enqueue = (text: string) => s.coordinator.enqueue(s.context.address, "gen-1", undefined, { botId: REMOTE, threadId: `${REMOTE}:chief-chat` }, text).node;
    await run(s, enqueue("First"));
    expect(await run(s, enqueue("Follow up"))).toMatchObject({ ok: true, text: expect.stringContaining("Done.") });
    expect(send.mock.calls.map(([, sent]) => (sent as { thread?: string }).thread)).toEqual([undefined, "t-1", undefined]);
    expect(JSON.parse(readFileSync(s.deps.file, "utf8")).conversations[`${REMOTE}:chief-chat`]).toMatchObject({ thread: "t-3" });
  });

  it("never sends the work again after a restart in the middle of sending it", async () => {
    const s = setup({ send: vi.fn(async () => { throw new Error("stopped while sending"); }) });
    const node = handed(s);
    await expect(run(s, node)).rejects.toThrow("stopped while sending");
    const send = vi.fn(async () => reply("twice"));
    const again = createRemoteHandoff({ ...s.deps, send }).host(innerHost());
    const result = await again.run(node, true, new AbortController().signal, { text: "", note: "", restartNote: "", turn: "rerun" });
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("may have arrived there; it was not sent again") });
    expect(send).not.toHaveBeenCalled();
  });

  it("gives a teammate's result on another server to the bot that handed it alone", () => {
    const s = setup();
    const node = handed(s);
    const parent = s.coordinator.node("gen-1");
    expect(s.remote.reportName(node, parent)).toBe("Ada (another server)");
    expect(s.remote.reportName(node, parent, "chief-id")).toBe("Ada (another server)");
    expect(s.remote.reportName(node, parent, "local-ada-twin")).toBeUndefined();
    expect(s.remote.reportName(node, undefined)).toBeUndefined();
    expect(s.remote.reportName(node, { botId: "gone-bot" })).toBeUndefined();
    expect(s.remote.reportName({ botId: "chief-id" }, parent)).toBeUndefined();
  });

  it("stops at once when the turn is stopped while it waits", async () => {
    const controller = new AbortController();
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => { controller.abort(); signal.throwIfAborted(); });
    const s = setup({ send: vi.fn(async () => working()), wait });
    const result = await run(s, handed(s), controller.signal);
    expect(result).toEqual({ ok: false, text: "Stopped before Ada's reply came back." });
  });

  it("refuses a teammate removed since, and leaves this server's own nodes to the host it wraps", async () => {
    const s = setup();
    const node = handed(s);
    expect(s.host.names(node, s.coordinator.node("gen-1"))).toEqual({ requester: "Chief", assignee: "Ada (another server)" });
    s.teammates.splice(0);
    expect(s.host.validate(node, s.coordinator.node("gen-1"))).toContain("was removed");
    const own = { ...node, botId: "chief-id" };
    expect(s.host.validate(own)).toBeUndefined();
    expect(s.inner.validate).toHaveBeenCalledWith(own, undefined);
    expect(await run(s, own)).toEqual({ ok: true, text: "local done" });
    expect(s.host.levelOf({ botId: REMOTE, threadId: "x" })).toEqual({ level: "full" });
  });

  it("sends nothing when the mark that stops a second send cannot be saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-handoff-"));
    dirs.push(dir);
    const blocker = join(dir, "not-a-folder");
    writeFileSync(blocker, "");
    const send = vi.fn(async () => reply("sent anyway"));
    const s = setup({ send, file: join(blocker, "remote-teammate-work.json") });
    const node = handed(s);
    const result = await run(s, node);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("was not sent") });
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores an unreadable record of sent work instead of failing to start", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-handoff-"));
    dirs.push(dir);
    const file = join(dir, "remote-teammate-work.json");
    writeFileSync(file, "{not json");
    const log = vi.fn();
    expect(() => createRemoteHandoff({ ...setup().deps, file, log })).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ignoring unreadable"));
  });
});

describe("remote teammate hand-off: rework", () => {
  it("stops rework to a teammate on another server after the limit under one request, and counts each request apart", async () => {
    let clock = 1_000;
    const s = setup({ now: () => clock });
    const rework = (round: number) => s.remote.coordinate(call([REMOTE], { rework: true, message: `Fix round ${round}` }), s.context, local);
    for (let round = 1; round <= REMOTE_REWORK_MAX; round++) expect((await rework(round)).status).toBe(200);
    const refused = await rework(REMOTE_REWORK_MAX + 1);
    expect(refused.status).not.toBe(200);
    expect((refused.body.receipts as Array<{ outcome: string; detail: string }>)[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining(`past the limit of ${REMOTE_REWORK_MAX}`) });
    expect(s.coordinator.children("gen-1")).toHaveLength(REMOTE_REWORK_MAX);

    s.coordinator.beginTurn({ id: "gen-2", address: { botId: "chief-id", threadId: "chief-chat" }, brief: "Next", level: "full", origin: { kind: "user", request: "Next" } });
    expect((await s.remote.coordinate(call([REMOTE], { rework: true, message: "Fix it" }), { ...s.context, generation: "gen-2" }, local)).status).toBe(200);

    clock += 6 * 60 * 60_000 + 1;
    expect((await rework(REMOTE_REWORK_MAX + 2)).status).toBe(200);
  });
});
