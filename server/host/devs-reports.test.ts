import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DevsReportPayload } from "../devs-report.ts";
import type { SendOutcome } from "../devs-report-send.ts";
import { personKey } from "../person-key.ts";
import type { PublicSession } from "../sessions.ts";
import type { Message, StoreChange } from "../store.ts";
import { createDevsReports, DEVS_REPORTS_FILE, LONGEST_WAIT_MS, NO_ANSWER_MS, RETRY_MS, sentLine, type DevsReportsDeps } from "./devs-reports.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SCOUT = { id: "scout", name: "Scout", threadId: "scout-main", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, composio: true };
const ROVER = { id: "rover", name: "Rover", threadId: "rover-main", modelSelection: { instanceId: "codex", model: "gpt-5.5", effort: "high" } };

function fixture(options: { dataDir?: string; outcomes?: SendOutcome[]; sessions?: PublicSession[]; ownerKey?: string | null; team?: boolean;
  profileEmail?: string; automated?: boolean } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omb-devs-reports-"));
  if (!options.dataDir) dirs.push(dataDir);
  const listeners = new Set<(change: StoreChange) => void>();
  const threads = new Map<string, Message[]>();
  let ids = 0, clock = Date.UTC(2026, 9, 27, 9, 0);
  const busy = new Set<string>();
  const bots = [SCOUT, ROVER];
  const groups = [{ id: "launch", name: "Launch", threadId: "room", memberIds: ["scout", "rover"] }];
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    botByThread: (threadId: string) => bots.find((bot) => bot.threadId === threadId) ?? null,
    groupByThread: (threadId: string) => groups.find((group) => group.threadId === threadId),
    projectBotForTask: () => null,
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }) => {
      const full = { id: `m${++ids}`, at: clock, ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      for (const listener of listeners) listener({ type: "message", threadId, message: full });
      return full;
    },
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const sent: DevsReportPayload[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  const deps: DevsReportsDeps = {
    dataDir, store: store as never, installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: "0.1.128", runsOn: "desktop app",
    working: (threadId) => busy.has(threadId), automated: () => options.automated === true,
    engine: (instanceId) => ({ name: instanceId === "claude" ? "Claude Code" : "Codex", snapshot: { state: "available", authenticated: true } }),
    appsReady: () => false, sessions: () => options.sessions ?? [], ownerKey: options.ownerKey ?? null, team: options.team === true,
    profileEmail: () => options.profileEmail, language: () => "en", recentLog: () => ["2026-10-27T08:59:00.000Z warn engine probe slow"],
    send: async (payload) => { sent.push(payload); return outcomes.shift() ?? { ok: true, id: `report-${sent.length}` }; },
    now: () => clock, timer: false,
  };
  const reports = createDevsReports(deps);
  const person = (threadId: string, text: string, extra: Partial<Message> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, sendId: `send-${ids}`, ...extra });
  const bot = (threadId: string, text: string, extra: Partial<Message> = {}) => store.appendMessage(threadId, { role: "bot", kind: "text", text, ...extra });
  const call = async (botId: string, threadId: string, body: unknown) => {
    let answer: { status: number; body: Record<string, unknown> } | undefined;
    await reports.internal({ method: "POST", path: "/api/internal/devs/report", botId, threadId, readBody: async () => body, res: {} as never,
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never });
    return answer!;
  };
  const settle = async () => { reports.tick(); await reports.idle(); };
  const notices = (threadId: string) => store.activePath(threadId).filter((line) => line.kind === "activity").map((line) => line.tool!.name);
  return { reports, store, sent, busy, person, bot, call, settle, notices, dataDir, advance: (ms: number) => { clock += ms; }, stop: () => reports.stop() };
}

describe("a message that tags @devs", () => {
  it("sends one report with the bot's summary when the bot calls report_bug, and the bot's reply tells the person", async () => {
    const fx = fixture({ profileEmail: "ada@example.com" });
    const line = fx.person("scout-main", "@devs pictures never load, key sk-ant-" + "a".repeat(40));
    const kept = readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8");
    expect(kept).toContain("pictures never load");
    expect(kept).not.toContain("sk-ant-a");
    fx.busy.add("scout-main");
    const note = fx.reports.note("scout-main", true);
    expect(note).toContain("tags @devs");
    expect(note).toContain("report_bug");
    fx.store.appendMessage("scout-main", { role: "bot", kind: "activity", tool: { name: "Bash", ok: false, output: "exit code 127: convert: not found" } });
    const answer = await fx.call("scout", "scout-main", { went_wrong: "Pictures never load", you_saw: "Bash failed with exit code 127", steps: "1. Attach a picture" });
    expect(answer.status).toBe(200);
    const line1 = sentLine("report-1", "ada@example.com");
    expect(answer.body.text).toBe(`Sent. Tell the person this line in your reply, word for word: "${line1}"`);
    expect(fx.sent).toHaveLength(1);
    const [payload] = fx.sent;
    expect(payload!.description.split("\n")[0]).toBe(`pictures never load, key «redacted ${"sk-ant-".length + 40} chars»`);
    expect(payload!.description).toContain("Scout's summary: Pictures never load");
    expect(payload!.diagnostics).toContain(`Message: ${line.id}`);
    expect(payload!.diagnostics).toContain("tool Bash failed: exit code 127: convert: not found");
    expect(payload!.diagnostics).toContain("Engine: Claude Code (claude), model claude-opus-5-5");
    expect(payload!.diagnostics).toContain("warn engine probe slow");
    expect(payload!.contactEmail).toBe("ada@example.com");
    expect(JSON.stringify(payload)).not.toContain("sk-ant-a");

    fx.bot("scout-main", `Thanks. ${line1}`, { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    fx.advance(LONGEST_WAIT_MS * 2);
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    expect(fx.notices("scout-main").filter((name) => name.startsWith("notice:"))).toEqual([]);
    expect(fx.reports.note("scout-main", true)).toBe("");
    expect((await fx.call("scout", "scout-main", { went_wrong: "again" })).body.text).toMatch(/^Already sent as report report-1/);
    fx.stop();
  });

  it("sends the facts itself, once, when the bot never calls report_bug, and a system line says so", async () => {
    const fx = fixture({ profileEmail: "ada@example.com" });
    fx.person("scout-main", "@devs the send button froze");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    await fx.settle();
    expect(fx.sent).toHaveLength(0);
    fx.bot("scout-main", "Sorry about that.", { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description).toContain("No summary from a bot: the bot did not call report_bug.");
    expect(fx.notices("scout-main")).toEqual([`notice: ${sentLine("report-1", "ada@example.com")}`]);
    fx.stop();
  });

  it("names why there is no summary: no answer, no tools, a failed turn, a turn that never ends", async () => {
    const fx = fixture();
    fx.person("scout-main", "@devs nobody answers");
    await fx.settle();
    expect(fx.sent).toHaveLength(0);
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent[0]!.description).toContain("no bot answered the message");
    expect(fx.notices("scout-main")).toEqual([`notice: ${sentLine("report-1")}`]);

    fx.person("rover-main", "@devs Codex is odd");
    fx.busy.add("rover-main");
    expect(fx.reports.note("rover-main", false)).toBe("");
    fx.busy.delete("rover-main");
    await fx.settle();
    expect(fx.sent[1]!.description).toContain("the bot's engine cannot use OpenMausBot's tools");
    expect(fx.sent[1]!.diagnostics).toContain("Engine: Codex (codex), model gpt-5.5, effort high");

    fx.person("scout-main", "@devs it failed");
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    fx.store.appendMessage("scout-main", { role: "bot", kind: "activity", tool: { name: "error: Claude Code is not signed in", ok: false, setup: true } });
    fx.busy.delete("scout-main");
    await fx.settle();
    expect(fx.sent[2]!.description).toContain("the bot's turn failed");
    expect(fx.sent[2]!.diagnostics).toContain("turn failed: Claude Code is not signed in (needs setup)");

    fx.person("scout-main", "@devs stuck forever");
    fx.busy.add("scout-main");
    await fx.settle();
    fx.advance(LONGEST_WAIT_MS);
    await fx.settle();
    expect(fx.sent[3]!.description).toContain("its turn was still running after 10 minutes");
    expect(fx.sent).toHaveLength(4);
    fx.stop();
  });

  it("is never a line in code, an old line, a bot's line, a teammate bot's ask or a routine's prompt", async () => {
    const fx = fixture({ automated: true });
    fx.person("scout-main", "look: `@devs` and\n```\n@devs\n```");
    fx.person("scout-main", "@devs from history", { at: Date.UTC(2026, 9, 26) });
    fx.bot("scout-main", "@devs is how you report a bug");
    fx.person("scout-main", "@devs from a teammate", { peerAsk: { botId: "rover", name: "Rover" } });
    fx.person("scout-main", "@devs routine prompt", { sendId: undefined });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toEqual([]);
    expect((await fx.call("scout", "scout-main", { went_wrong: "x" })).status).toBe(409);
    fx.person("scout-main", "@devs a person during a routine");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });
});

describe("a report that cannot go yet", () => {
  it("is saved, the person is told, and it goes on its own later", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }, { ok: false, retry: true, why: "limited", retryAfterMs: 20 * 60_000 }] });
    fx.person("scout-main", "@devs offline");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.notices("scout-main")).toEqual(["notice: Not sent yet: the MausBot team's server could not be reached. The report is saved and goes on its own as soon as it can, so there is no need to send it again."]);
    const saved = JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8"));
    expect(saved.outbox).toHaveLength(1);
    expect(saved.outbox[0].payload.description).toContain("offline");

    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    fx.advance(19 * 60_000);
    await fx.settle();
    expect(fx.sent).toHaveLength(2);
    fx.advance(60_000);
    await fx.settle();
    expect(fx.sent).toHaveLength(3);
    expect(fx.sent[2]).toEqual(fx.sent[0]);
    expect(fx.notices("scout-main").at(-1)).toBe("notice: Sent to the MausBot team (report report-3) after an earlier try did not go through. Milind and Omkar get it by email.");
    expect(JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).outbox).toEqual([]);
    fx.stop();
  });

  it("is dropped when the endpoint refuses it, and the person is told why", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: false, why: "refused", detail: "description must be 1 to 10,000 characters of text." }] });
    fx.person("scout-main", "@devs refused");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.notices("scout-main")).toEqual(["notice: The MausBot team's server refused this bug report, so nothing was sent: description must be 1 to 10,000 characters of text."]);
    fx.advance(RETRY_MS.at(-1)! * 2);
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    fx.stop();
  });

  it("still goes after a restart, without waiting for a bot that is no longer working", async () => {
    const first = fixture();
    first.person("scout-main", "@devs before the restart");
    first.stop();
    expect(first.sent).toEqual([]);
    const second = fixture({ dataDir: first.dataDir });
    await second.settle();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.description).toContain("OpenMausBot restarted before a bot wrote one");
    second.stop();
    writeFileSync(join(first.dataDir, DEVS_REPORTS_FILE), "not json");
    const third = fixture({ dataDir: first.dataDir });
    await third.settle();
    expect(third.sent).toEqual([]);
    third.stop();
  });
});

describe("the person's address", () => {
  it("is their signed-in session's, the owner's on My Cloud, else the profile's off a team", async () => {
    const session = (email: string, scopes: string[] = ["client"]) => ({ id: email, label: email, scopes, createdAt: 1, lastSeenAt: 1, expiresAt: 9e15, email }) as PublicSession;
    const sent = async (options: Parameters<typeof fixture>[0], sender?: { name: string; id?: string }) => {
      const fx = fixture(options);
      fx.person("scout-main", "@devs address", sender ? { sender } : {});
      fx.advance(NO_ANSWER_MS);
      await fx.settle();
      fx.stop();
      return fx.sent[0]!.contactEmail;
    };
    expect(await sent({ sessions: [session("bob@acme.test")], team: true }, { name: "Bob", id: personKey({ id: "", email: "bob@acme.test" }) })).toBe("bob@acme.test");
    expect(await sent({ sessions: [session("bob@acme.test")], team: true, profileEmail: "server@acme.test" }, { name: "Carl", id: "p_unknownunknownunknown" })).toBeUndefined();
    expect(await sent({ sessions: [session("owner@example.com", ["admin"])], ownerKey: "p_owner" }, { name: "Ada", id: "p_owner" })).toBe("owner@example.com");
    expect(await sent({ profileEmail: "Ada@Example.com" })).toBe("ada@example.com");
    expect(await sent({ profileEmail: "not an address" })).toBeUndefined();
  });
});

describe("a group chat", () => {
  it("sends from the bot handling the message, and a second bot is told it already went", async () => {
    const fx = fixture();
    fx.person("room", "@devs the room is stuck");
    fx.busy.add("room");
    expect(fx.reports.note("room", true)).toContain("report_bug");
    expect((await fx.call("rover", "room", { went_wrong: "The room is stuck" })).status).toBe(200);
    expect(fx.reports.note("room", true)).toBe("");
    expect((await fx.call("scout", "room", { went_wrong: "The room is stuck" })).body.text).toMatch(/^Already sent as report report-1/);
    fx.bot("room", "Done.", { from: { botId: "rover", name: "Rover", color: "blue" }, turnId: "t1", turnSucceeded: true });
    fx.busy.delete("room");
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.description).toContain("Where: the group chat \"Launch\" with 2 bots");
    expect(fx.sent[0]!.diagnostics).toContain("Group chat: launch");
    expect(fx.sent[0]!.diagnostics).toContain("Bot: Rover (rover)");
    expect(fx.sent[0]!.diagnostics).not.toContain("Bot: Scout (scout)");
    expect(fx.notices("room")).toEqual([`notice: ${sentLine("report-1")}`]);
    fx.stop();
  });

  it("still sends the facts for a message no bot answers", async () => {
    const fx = fixture();
    fx.person("room", "@devs @Bob this page is blank");
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]!.diagnostics).toContain("Bot: Scout (scout)");
    expect(fx.sent[0]!.diagnostics).toContain("Bot: Rover (rover)");
    fx.stop();
  });
});
