import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { DevsReportPayload } from "../devs-report.ts";
import type { ReportStatusAnswer, ReportStatusQuestion, SendOutcome } from "../devs-report-send.ts";
import { personKey } from "../person-key.ts";
import type { PublicSession } from "../sessions.ts";
import type { Message, StoreChange } from "../store.ts";
import { createDevsReports, DEVS_REPORTS_FILE, fixedLine, LONGEST_WAIT_MS, NO_ANSWER_MS, RETRY_MS, sentLine, STATUS_EVERY_MS, STATUS_FIRST_MS, TRACKED_MS,
  type DevsReportsDeps } from "./devs-reports.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SCOUT = { id: "scout", name: "Scout", threadId: "scout-main", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, composio: true };
const ROVER = { id: "rover", name: "Rover", threadId: "rover-main", modelSelection: { instanceId: "codex", model: "gpt-5.5", effort: "high" } };

function fixture(options: { dataDir?: string; outcomes?: SendOutcome[]; sessions?: PublicSession[]; ownerKey?: string | null; team?: boolean;
  profileEmail?: string; automated?: boolean; lineLanguage?: DevsReportsDeps["lineLanguage"]; appVersion?: string; clock?: number;
  /** The conversations, kept across a restart (another fixture on the same data). */
  threads?: Map<string, Message[]>;
  /** The MausBot team's answer to each question about this app's reports; none: no answer (offline). */
  answer?: (question: ReportStatusQuestion) => ReportStatusAnswer | null } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omb-devs-reports-"));
  if (!options.dataDir) dirs.push(dataDir);
  const listeners = new Set<(change: StoreChange) => void>();
  const threads = options.threads ?? new Map<string, Message[]>();
  let ids = [...threads.values()].reduce((sum, lines) => sum + lines.length, 0), clock = options.clock ?? Date.UTC(2026, 9, 27, 9, 0);
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
      const full = { id: `${threadId}:m${++ids}`, at: clock, ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      for (const listener of listeners) listener({ type: "message", threadId, message: full });
      return full;
    },
    patchMessage: (threadId: string, messageId: string, patch: Partial<Message>) => {
      const lines = threads.get(threadId);
      if (!lines) throw new Error("no such conversation");
      const index = lines.findIndex((line) => line.id === messageId);
      if (index < 0) return null;
      lines[index] = { ...lines[index]!, ...patch };
      return lines[index]!;
    },
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const sent: DevsReportPayload[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  const asked: ReportStatusQuestion[] = [], told: Array<{ threadId: string; text: string; person?: string }> = [];
  const deps: DevsReportsDeps = {
    dataDir, store: store as never, installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: options.appVersion ?? "0.1.128", runsOn: "desktop app",
    working: (threadId) => busy.has(threadId), automated: () => options.automated === true,
    engine: (instanceId) => ({ name: instanceId === "claude" ? "Claude Code" : "Codex", snapshot: { state: "available", authenticated: true } }),
    appsReady: () => false, sessions: () => options.sessions ?? [], ownerKey: options.ownerKey ?? null, team: options.team === true,
    profileEmail: () => options.profileEmail, language: () => "en", ...(options.lineLanguage ? { lineLanguage: options.lineLanguage } : {}),
    recentLog: () => ["2026-10-27T08:59:00.000Z warn engine probe slow"],
    send: async (payload) => { sent.push(payload); return outcomes.shift() ?? { ok: true, id: `report-${sent.length}` }; },
    askStatus: async (question) => { asked.push(question); return options.answer?.(question) ?? null; },
    tell: (threadId, text, person) => { told.push({ threadId, text, ...(person ? { person } : {}) }); },
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
  const line = (threadId: string, messageId: string) => store.activePath(threadId).find((one) => one.id === messageId);
  /** The conversation is deleted, as the store says it. */
  const drop = (threadId: string) => { threads.delete(threadId); for (const listener of listeners) listener({ type: "thread.deleted", threadId } as StoreChange); };
  return { reports, store, sent, busy, person, bot, call, settle, notices, dataDir, asked, told, line, drop, threads, now: () => clock,
    advance: (ms: number) => { clock += ms; }, stop: () => reports.stop() };
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

describe("what the person is told, in their language", () => {
  const german = (person?: string) => (person === "p-ada" ? "de" : undefined);
  const ada = { sender: { name: "Ada", id: "p-ada" } };

  it("the line the bot passes on is German, and so is the system line when the bot does not pass it on", async () => {
    const fx = fixture({ profileEmail: "ada@example.com", lineLanguage: german });
    fx.person("scout-main", "@devs die Bilder laden nicht", ada);
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    const answer = await fx.call("scout", "scout-main", { went_wrong: "Bilder laden nicht" });
    const line = "An das MausBot-Team gesendet (Bericht report-1). Milind und Omkar bekommen ihn per E-Mail und antworten dir an ada@example.com.";
    expect(answer.body.text).toBe(`Sent. Tell the person this line in your reply, word for word: "${line}"`);
    fx.bot("scout-main", "Ich schaue mir das an.", { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    expect(fx.notices("scout-main")).toEqual([`notice: ${line}`]);
    fx.stop();
  });

  it("a report that waits is explained in German, not twice when the bot passed it on, and its later send is told in German", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }], lineLanguage: german });
    fx.person("scout-main", "@devs offline", ada);
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    const answer = await fx.call("scout", "scout-main", { went_wrong: "offline" });
    const waiting = "Noch nicht gesendet: der Server des MausBot-Teams war nicht erreichbar. Der Bericht ist gespeichert und wird so bald wie möglich von selbst gesendet, du musst ihn also nicht noch einmal senden.";
    expect(answer.body.text).toBe(`Not sent. Tell the person this line in your reply, word for word: "${waiting}"`);
    fx.bot("scout-main", waiting, { turnId: "t1", turnSucceeded: true });
    fx.busy.delete("scout-main");
    await fx.settle();
    expect(fx.notices("scout-main")).toEqual([]);
    fx.advance(RETRY_MS[0]);
    await fx.settle();
    expect(fx.notices("scout-main")).toEqual(["notice: An das MausBot-Team gesendet (Bericht report-2), nachdem ein früherer Versuch nicht geklappt hat. Milind und Omkar bekommen ihn per E-Mail."]);
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

describe("closing the loop on a report", () => {
  /** Every report asked about, answered as the MausBot team would: `fixedIn` for all of them, `notify` as given. */
  const team = (state: { status: "received" | "fixed"; fixedIn: string | null; notify: boolean }) => (question: ReportStatusQuestion): ReportStatusAnswer =>
    ({ reports: question.ids.map((id) => ({ id, status: state.status, fixedIn: state.fixedIn })), notify: state.notify });
  /** A report sent from Scout's chat by Bob, with Scout's summary; the person's message. */
  async function reported(fx: ReturnType<typeof fixture>, words = "@devs the calendar never syncs") {
    const message = fx.person("scout-main", words, { sender: { name: "Bob", id: "p_bob_bob_bob_bob_bob_bob_bob" } });
    fx.busy.add("scout-main");
    fx.reports.note("scout-main", true);
    expect((await fx.call("scout", "scout-main", { went_wrong: "The calendar never syncs" })).status).toBe(200);
    fx.busy.delete("scout-main");
    await fx.settle();
    return message;
  }
  const fixedLines = (fx: ReturnType<typeof fixture>) => fx.notices("scout-main").filter((name) => name.startsWith("notice: Fixed in"));
  const later = async (fx: ReturnType<typeof fixture>, ms: number) => { fx.advance(ms); await fx.settle(); };

  it("shows the person their report's status on the message that sent it: got it, then fixed and coming, without a word in the chat until it runs here", async () => {
    const state = { status: "received" as "received" | "fixed", fixedIn: null as string | null, notify: true };
    const fx = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(fx);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "received" });
    const kept = JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8"));
    expect(kept.tracked).toEqual([expect.objectContaining({ reportId: "report-1", threadId: "scout-main", messageId: message.id, status: "received",
      installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", person: "p_bob_bob_bob_bob_bob_bob_bob", words: "the calendar never syncs" })]);
    // The first question goes a minute after a start, with this install's id and its open reports.
    await later(fx, STATUS_FIRST_MS - 1_000);
    expect(fx.asked).toEqual([]);
    await later(fx, 1_000);
    expect(fx.asked).toEqual([{ installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", ids: ["report-1"] }]);
    // Fixed, the release not known yet; then known, but this app runs an older one.
    Object.assign(state, { status: "fixed", fixedIn: null });
    await later(fx, STATUS_EVERY_MS);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed" });
    Object.assign(state, { fixedIn: "0.1.129" });
    await later(fx, STATUS_EVERY_MS);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129" });
    expect(fx.asked).toHaveLength(3);
    expect([fixedLines(fx), fx.told]).toEqual([[], []]);
    fx.stop();
  });

  it("tells the person once, in the chat they reported in, only once this app runs the fix's release, and the bot's next turn there knows why", async () => {
    const state = { status: "fixed" as const, fixedIn: "0.1.129", notify: true };
    const before = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(before);
    await later(before, STATUS_FIRST_MS);
    expect(fixedLines(before)).toEqual([]);
    before.stop();
    // The app updates to the fix's release and starts again: one line, one notification, the message says it runs here.
    const after = fixture({ dataDir: before.dataDir, threads: before.threads, appVersion: "0.1.129", clock: before.now(), answer: team(state) });
    await later(after, STATUS_FIRST_MS);
    expect(fixedLines(after)).toEqual([`notice: ${fixedLine("0.1.129")}`]);
    expect(after.store.activePath("scout-main").at(-1)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129", running: true });
    expect(after.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.129", running: true });
    expect(after.told).toEqual([{ threadId: "scout-main", text: "Fixed in 0.1.129. Want to try again?", person: "p_bob_bob_bob_bob_bob_bob_bob" }]);
    expect(JSON.parse(readFileSync(join(after.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked[0].told).toBe(after.now());
    // Never again: not on the next round, nor after another start.
    for (let round = 0; round < 3; round++) await later(after, STATUS_EVERY_MS);
    expect(after.asked).toHaveLength(1);
    expect(fixedLines(after)).toHaveLength(1);
    expect(after.told).toHaveLength(1);
    // The bot's next turn in that chat is told why, once; another chat's isn't.
    expect(after.reports.note("rover-main", true)).toBe("");
    const note = after.reports.note("scout-main", true);
    expect(note).toContain("is fixed in 0.1.129, which this app now runs");
    expect(note).toContain('("the calendar never syncs")');
    expect(after.reports.note("scout-main", true)).toBe("");
    after.stop();
    const again = fixture({ dataDir: before.dataDir, threads: before.threads, appVersion: "0.1.130", clock: after.now(), answer: team(state) });
    await later(again, STATUS_FIRST_MS + STATUS_EVERY_MS);
    // The same conversation: still the one line it got.
    expect([again.asked, fixedLines(again), again.told]).toEqual([[], [`notice: ${fixedLine("0.1.129")}`], []]);
    expect(again.reports.note("scout-main", true)).toBe("");
    again.stop();
  });

  it("tells a former customer nothing: the team's answer says not to, or they left the team", async () => {
    const state = { status: "fixed" as const, fixedIn: "0.1.128", notify: false };
    const fx = fixture({ appVersion: "0.1.128", answer: team(state) });
    const message = await reported(fx);
    for (let round = 0; round < 3; round++) await later(fx, STATUS_EVERY_MS);
    expect([fixedLines(fx), fx.told]).toEqual([[], []]);
    // Its status still reads on their own message, which only they see.
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-1", status: "fixed", fixedIn: "0.1.128", running: true });
    // Back as a customer: told then, once.
    state.notify = true;
    await later(fx, STATUS_EVERY_MS);
    expect(fixedLines(fx)).toEqual([`notice: ${fixedLine("0.1.128")}`]);
    expect(fx.told).toHaveLength(1);
    fx.stop();

    const team2 = fixture({ appVersion: "0.1.128", answer: team({ ...state, notify: true }) });
    await reported(team2);
    team2.reports.forget("p_bob_bob_bob_bob_bob_bob_bob");
    await later(team2, STATUS_FIRST_MS);
    expect([team2.asked, fixedLines(team2), team2.told]).toEqual([[], [], []]);
    team2.stop();
  });

  it("asks again after no answer, stops at a report the team doesn't know, and lets go of a report after its time or with its conversation", async () => {
    let answer: ReportStatusAnswer | null = null;
    const fx = fixture({ answer: () => answer });
    await reported(fx);
    await later(fx, STATUS_FIRST_MS);
    await later(fx, STATUS_EVERY_MS);
    expect(fx.asked).toHaveLength(2);
    answer = { reports: [{ id: "report-1", status: "unknown", fixedIn: null }], notify: true };
    await later(fx, STATUS_EVERY_MS);
    await later(fx, STATUS_EVERY_MS);
    expect(fx.asked).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(fx.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked).toEqual([]);
    fx.stop();

    const old = fixture({ answer: () => null });
    await reported(old);
    await later(old, TRACKED_MS);
    expect(old.asked).toEqual([]);
    old.stop();

    const gone = fixture({ answer: () => null });
    await reported(gone);
    gone.drop("scout-main");
    await later(gone, STATUS_FIRST_MS);
    expect(gone.asked).toEqual([]);
    expect(JSON.parse(readFileSync(join(gone.dataDir, DEVS_REPORTS_FILE), "utf8")).tracked).toEqual([]);
    gone.stop();
  });

  it("follows a report that went later, from the outbox, as it follows one that went at once", async () => {
    const fx = fixture({ outcomes: [{ ok: false, retry: true, why: "offline" }], answer: team({ status: "fixed", fixedIn: "0.1.128", notify: true }) });
    const message = fx.person("scout-main", "@devs pictures never load", { sender: { name: "Bob", id: "p_bob_bob_bob_bob_bob_bob_bob" } });
    fx.advance(NO_ANSWER_MS);
    await fx.settle();
    expect(fx.line("scout-main", message.id)!.bugReport).toBeUndefined();
    await later(fx, RETRY_MS[0]);
    expect(fx.sent).toHaveLength(2);
    expect(fx.line("scout-main", message.id)!.bugReport).toEqual({ id: "report-2", status: "received" });
    await later(fx, STATUS_EVERY_MS);
    expect(fixedLines(fx)).toEqual([`notice: ${fixedLine("0.1.128")}`]);
    expect(fx.told).toEqual([{ threadId: "scout-main", text: fixedLine("0.1.128"), person: "p_bob_bob_bob_bob_bob_bob_bob" }]);
    expect(fx.reports.note("scout-main", true)).toContain('("pictures never load")');
    fx.stop();
  });
});
