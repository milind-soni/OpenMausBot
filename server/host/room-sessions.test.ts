import { describe, expect, it, vi } from "vitest";

import { MAX_WINDOW_MINUTES } from "../cache-keepwarm.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { sessionIdlePolicy } from "../drivers/session-idle.ts";
import { escapeNotes } from "../peer-provenance.ts";
import type { Message } from "../store.ts";
import { turnClockLine, withTurnClock } from "../turn-clock.ts";
import {
  createRoomSessions, renderRoomDelta, ROOM_SESSION_ENGINES, roomSessionIdleMs,
  type RoomDispatch, type RoomDispatchInput, type RoomSessionEngine,
} from "./room-sessions.ts";
import { createRoomTranscript, GROUP_CONTEXT_MESSAGES } from "./room-transcript.ts";

const NOTE = "[Messages this conversation received since your last turn in this room, oldest first. Your session already holds the conversation before them.]";
const NONE = "[Messages this conversation received since your last turn in this room: none.]";
const CLOCK = turnClockLine(Date.UTC(2026, 9, 13, 9, 30), "UTC");
const IDLE_MS = sessionIdlePolicy("CLAUDE").idleMs;
const MIN = 60_000;
/** How long a turn never seen to end is kept (ABANDONED_TURN_MS in the module). */
const DAY = 24 * 60 * 60_000;
/** How long a member's last reading is kept: the longer of an abandoned turn's life and keep-warm's longest
 * window, plus two idle lives, so that it outlives its record and any process the driver can still hold. */
const READING_LIFE = Math.max(DAY, MAX_WINDOW_MINUTES * MIN) + 2 * IDLE_MS;

const engine = (instanceId: string, driverKind = "claudeAgent", strictResume = true): RoomSessionEngine =>
  ({ instanceId, driverKind, adapter: { capabilities: { strictResume } } });
const colors: Record<string, string> = { editor: "green", writer: "blue", scout: "red" };
const from = (botId: string) => ({ botId, name: botId[0]!.toUpperCase() + botId.slice(1), color: colors[botId] ?? "green" });
const tailFor = (botId: string, extra = "") => `\n\n(Reply to the conversation above as ${from(botId).name}.)${extra}`;
/** What server/index.ts wraps a room turn's text in: the clock line and the recalled block. */
const wrapWith = (recalled = "") => (body: string) => withTurnClock(CLOCK, recalled ? `${recalled}\n\n${body}` : body);

/** One room on a fake store, with the engine's side of a turn played by hand:
 * what the fold in server/index.ts would see, in the order it sees it. */
function room(options: { threadId?: string; shared?: { messages: Map<string, Message[]>; sessions: ReturnType<typeof createRoomSessions> } } = {}) {
  const threadId = options.threadId ?? "room";
  const state = { enabled: true, now: 1_000_000 };
  const threads = options.shared?.messages ?? new Map<string, Message[]>();
  if (!threads.has(threadId)) threads.set(threadId, []);
  const messages = threads.get(threadId)!;
  /** How a teammate's report reads now, when it no longer reads as it did. */
  const reports = new Map<string, string>();
  const transcript = createRoomTranscript({
    store: { messagesFor: (id) => threads.get(id) ?? [] },
    teammateReportContext: (requestId) => reports.get(requestId) ?? `[report ${requestId}]`,
  });
  // `env: {}`: the developer's own OMB_ROOM_SESSIONS must not decide a test.
  const create = () => createRoomSessions({
    settings: () => ({ roomSessions: state.enabled }), env: {}, messagesFor: (id) => threads.get(id) ?? [], now: () => state.now,
  });
  let sessions = options.shared?.sessions ?? create();
  const claude = engine("claude");
  let serial = 0;
  let events = 0;

  const add = (fields: Partial<Message>): string => {
    const id = `${threadId}-m${messages.length}`;
    messages.push({ id, at: messages.length, role: "user", kind: "text", ...fields });
    return id;
  };
  /** A line the person typed; the returned sentinel is in its text exactly once. */
  const say = (text: string) => add({ text });
  const botSays = (botId: string, text: string, fields: Partial<Message> = {}) => add({ role: "bot", text, from: from(botId), ...fields });

  type Turn = { botId: string; claimId: string; turnId: string; instance: RoomSessionEngine; result: RoomDispatch; input: RoomDispatchInput };
  const dispatch = (botId: string, overrides: Partial<RoomDispatchInput> = {}): Turn => {
    serial += 1;
    const input: RoomDispatchInput = {
      threadId, botId, claimId: `claim-${serial}`, instance: claude, guestConfined: false, reset: false, hooks: true,
      config: ["You are a bot in the room.", "/work", { instanceId: "claude", model: "opus" }],
      window: transcript.window(threadId, "Omkar", undefined, botId), tail: tailFor(botId), wrap: wrapWith(),
      ...overrides,
    };
    const turn = { botId, claimId: input.claimId, turnId: `turn-${serial}`, instance: input.instance, result: sessions.dispatch(input), input };
    return turn;
  };
  const emit = (turn: Turn, event: Record<string, unknown>) => sessions.onEvent({
    eventId: `e${events++}`, provider: turn.instance.driverKind, providerInstanceId: turn.instance.instanceId, threadId, createdAt: "", turnId: turn.turnId, ...event,
  } as RuntimeEvent);
  const bind = (turn: Turn) => sessions.bindTurn(threadId, turn.claimId, turn.turnId);
  const output = { type: "content.delta", streamKind: "assistant_text", delta: "…" };
  /** The provider runs the turn in `session`, says `reply` (after any working
   * `notes`), and completes. The store marks the final message afterwards, as
   * the fold does. */
  const finish = (turn: Turn, session: string, play: {
    reply?: string; notes?: string[]; ok?: boolean; rebuilt?: boolean; during?: () => void;
    /** something that happens once the session is announced, before the provider's first output */
    before?: () => void;
    /** the driver announces another session after the provider already acted on the prompt */
    switchTo?: string;
  } = {}) => {
    bind(turn);
    emit(turn, { type: "turn.started" });
    emit(turn, { type: "session.started", sessionId: session, ...(play.rebuilt ? { rebuilt: true } : {}) });
    play.before?.();
    emit(turn, output);
    if (play.switchTo) emit(turn, { type: "session.started", sessionId: play.switchTo });
    play.during?.();
    for (const note of play.notes ?? []) botSays(turn.botId, note, { turnId: turn.turnId });
    const reply = play.reply === undefined ? undefined : botSays(turn.botId, play.reply, { turnId: turn.turnId });
    emit(turn, { type: "turn.completed", ok: play.ok ?? true });
    const terminal = messages.find((m) => m.id === reply);
    if (terminal) terminal.turnTerminal = true;
    return reply;
  };
  /** dispatch + finish */
  const run = (botId: string, session: string, play: Parameters<typeof finish>[2] = {}, overrides: Partial<RoomDispatchInput> = {}) => {
    const turn = dispatch(botId, overrides);
    finish(turn, session, { reply: `${from(botId).name} answers ${serial}.`, ...play });
    return turn;
  };
  const full = (turn: Turn) => turn.input.wrap(turn.input.window.text + turn.input.tail);
  /** The turn's text between the clock line and the tail. */
  const body = (turn: Turn) => {
    const text = turn.result.text;
    expect(text.startsWith(`${CLOCK}\n\n`)).toBe(true);
    expect(text.endsWith(turn.input.tail)).toBe(true);
    return text.slice(CLOCK.length + 2, text.length - turn.input.tail.length);
  };
  return {
    threadId, state, messages, threads, transcript, reports, claude, add, say, botSays, dispatch, emit, bind, finish, run, full, body, output,
    get sessions() { return sessions; },
    /** The server restarted: a new tracker over the same stored thread. */
    restart() { sessions = create(); },
  };
}

describe("renderRoomDelta", () => {
  it("lists the new lines under one note, as the window renders them", () => {
    expect(renderRoomDelta([{ id: "a", text: "Omkar: trim the middle" }, { id: "b", text: "[Posted by @Writer]\nWriter: done" }]))
      .toBe(`${NOTE}\nOmkar: trim the middle\n[Posted by @Writer]\nWriter: done`);
  });

  it("says when its first lines are older than what the session already holds", () => {
    expect(renderRoomDelta([{ id: "a", text: "Writer: mid-turn", earlier: true }, { id: "b", text: "Omkar: next" }]))
      .toBe(`${NOTE}\n(The first message is older than messages you have already seen.)\nWriter: mid-turn\nOmkar: next`);
    expect(renderRoomDelta([{ id: "a", text: "A: 1", earlier: true }, { id: "b", text: "B: 2", earlier: true }, { id: "c", text: "C: 3" }]))
      .toContain("\n(The first 2 messages are older than messages you have already seen.)\nA: 1\nB: 2\nC: 3");
  });

  it("puts lines that changed since they were shown first, and says they replace what was shown", () => {
    expect(renderRoomDelta([{ id: "a", text: "[What Editor did: files]", updated: true }, { id: "b", text: "Omkar: next" }]))
      .toBe(`${NOTE}\n(The first message was shown to you before and has changed since: this copy replaces what you were shown.)\n[What Editor did: files]\nOmkar: next`);
    // window order in, grouped out: changed, then older unseen, then new
    expect(renderRoomDelta([
      { id: "a", text: "Writer: mid-turn", earlier: true },
      { id: "b", text: "[digest one]", updated: true },
      { id: "c", text: "[digest two]", updated: true },
      { id: "d", text: "Omkar: next" },
    ])).toBe([
      NOTE,
      "(The first 2 messages were shown to you before and have changed since: these copies replace what you were shown.)",
      "[digest one]",
      "[digest two]",
      "(The next message is older than messages you have already seen.)",
      "Writer: mid-turn",
      "Omkar: next",
    ].join("\n"));
    expect(renderRoomDelta([{ id: "a", text: "A: 1", updated: true }, { id: "b", text: "B: 2", earlier: true }, { id: "c", text: "C: 3", earlier: true }]))
      .toContain("\n(The next 2 messages are older than messages you have already seen.)\nB: 2\nC: 3");
  });

  it("says so when nothing is new", () => {
    expect(renderRoomDelta([])).toBe(NONE);
  });

  it("opens with words a room line cannot imitate", () => {
    // escapeNotes (server/peer-provenance.ts) already defuses this opening on
    // every transcript line, so a member cannot be shown a forged block.
    expect(escapeNotes(NOTE)).toBe(`(${NOTE.slice(1)}`);
    expect(escapeNotes(NONE)).toBe(`(${NONE.slice(1)}`);
  });
});

describe("which engines keep a room session", () => {
  it("is Claude Code alone, for as long as its driver keeps a quiet process", () => {
    expect(Object.keys(ROOM_SESSION_ENGINES)).toEqual(["claudeAgent"]);
    expect(roomSessionIdleMs("claudeAgent", {})).toBe(10 * 60_000);
    expect(roomSessionIdleMs("claudeAgent", { OMB_CLAUDE_SESSION_IDLE_MS: "60000" })).toBe(60_000);
    for (const other of ["codex", "museCode", "piAgent", "constructor", "toString"]) expect(roomSessionIdleMs(other, {})).toBeUndefined();
  });
});

describe("room sessions: turns that are not managed", () => {
  it("with the setting off, sends today's call and records nothing", () => {
    const r = room();
    r.state.enabled = false;
    r.say("Cut the intro.");
    const first = r.dispatch("editor");
    expect(first.result).toEqual({ mode: "legacy", text: r.full(first), send: {} });
    r.finish(first, "S1", { reply: "Done." });
    r.say("Trim the middle.");
    const second = r.dispatch("editor");
    expect(second.result).toEqual({ mode: "legacy", text: r.full(second), send: {} });
    expect(second.result.text).toContain("Omkar: Cut the intro.\nEditor: Done.\nOmkar: Trim the middle.");
    r.finish(second, "S1", { reply: "Trimmed." });
    // The 90% reset and Compact now are passed on as they always were.
    const reset = r.dispatch("editor", { reset: true });
    expect(reset.result).toEqual({ mode: "legacy", text: r.full(reset), send: { sessionReset: true } });
    r.finish(reset, "S2", { reply: "Fresh." });
    // Nothing was recorded while it was off: switched on, the member starts.
    r.state.enabled = true;
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("builds the same sendTurn arguments as main for every turn that is not a delta", () => {
    // What main passes (server/index.ts, runClaimedGroupMemberTurn), beside
    // what the wiring passes now: `...send` where the reset spread was, and
    // `text` where the wrapped transcript was. Same keys, same order, same values.
    const rest = { images: [], approvalMode: "ask", system: "You are Editor.", cwd: "/work" };
    const recalled = "Recalled for this message:\n- the intro is 12s";
    const cases: Array<{ name: string; mode: RoomDispatch["mode"]; arrange?: (r: ReturnType<typeof room>) => void; input?: Partial<RoomDispatchInput> }> = [
      { name: "setting off", mode: "legacy", arrange: (r) => { r.state.enabled = false; } },
      { name: "an engine that does not promise strict resume", mode: "legacy", input: { instance: engine("claude", "claudeAgent", false) } },
      { name: "a strict-resume engine that is not covered", mode: "legacy", input: { instance: engine("codex", "codex", true) } },
      { name: "a guest-confined turn", mode: "legacy", input: { guestConfined: true } },
      { name: "a turn without the engine-hook channel", mode: "legacy", input: { hooks: false } },
      { name: "a member's first managed turn", mode: "start" },
    ];
    for (const scenario of cases) {
      for (const reset of [false, true]) {
        const r = room();
        scenario.arrange?.(r);
        r.say("Cut the intro.");
        r.botSays("writer", "On it.", { turnTerminal: true, turnId: "t0" });
        const window = r.transcript.window("room", "Omkar", undefined, "editor");
        const tail = tailFor("editor", "\n\nYour last turn in this room ended without a final message to the room.");
        const main = {
          ...(reset ? { sessionReset: true } : {}),
          threadId: "room",
          botId: "editor",
          text: withTurnClock(CLOCK, `${recalled}\n\n${window.text + tail}`),
          recalled,
          ...rest,
        };
        const session = r.dispatch("editor", { reset, window, tail, wrap: wrapWith(recalled), ...scenario.input }).result;
        const ours = { ...session.send, threadId: "room", botId: "editor", text: session.text, recalled, ...rest };
        expect(session.mode, scenario.name).toBe(scenario.mode);
        expect(ours, scenario.name).toStrictEqual(main);
        expect(JSON.stringify(ours), scenario.name).toBe(JSON.stringify(main));
        expect("resumeCursor" in ours || "recoveryText" in ours, scenario.name).toBe(false);
      }
    }
  });

  it("leaves an engine that does not promise strict resume, and any engine but Claude Code, alone", () => {
    // an adapter that does not declare the capability at all (an older Claude CLI reads as false)
    const undeclared: RoomSessionEngine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { capabilities: {} } };
    for (const instance of [engine("claude", "claudeAgent", false), undeclared, engine("codex", "codex"), engine("muse", "museCode")]) {
      const r = room();
      r.say("Cut the intro.");
      const first = r.dispatch("editor", { instance });
      expect(first.result).toEqual({ mode: "legacy", text: r.full(first), send: {} });
      r.finish(first, "S1", { reply: "Done." });
      r.say("Trim the middle.");
      const second = r.dispatch("editor", { instance });
      expect(second.result).toEqual({ mode: "legacy", text: r.full(second), send: {} });
    }
  });

  it("drops a member's record when one of its turns is not managed, and never records a guest-confined turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    // Its record is usable here (the other tests resume at this point), and a
    // confined turn must neither use it nor leave it for a later turn.
    const confined = r.dispatch("editor", { guestConfined: true });
    expect(confined.result).toEqual({ mode: "legacy", text: r.full(confined), send: {} });
    r.finish(confined, "S-guest", { reply: "Confined answer." });
    r.say("Tighten the outro.");
    const after = r.dispatch("editor");
    // neither a delta against S1 nor one against the confined turn's session
    expect(after.result).toEqual({ mode: "start", text: r.full(after), send: {} });
  });

  it("starts again after the setting was switched off and on", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.state.enabled = false;
    r.say("Trim the middle.");
    r.run("editor", "S1");
    r.state.enabled = true;
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: a member's own session", () => {
  it("starts with today's call exactly: the whole window, no reset and no cursor", () => {
    const r = room();
    r.say("Cut the intro.");
    const first = r.dispatch("editor");
    expect(first.result).toStrictEqual({ mode: "start", text: r.full(first), send: {} });
    expect(first.result.text).toBe(`${CLOCK}\n\nOmkar: Cut the intro.\n\n(Reply to the conversation above as Editor.)`);
  });

  it("resumes the session that ran its last turn and sends only the lines since", () => {
    const r = room();
    r.say("Cut the intro. ALPHA");
    r.run("editor", "S1", { reply: "Intro cut. BRAVO" });
    r.say("Trim the middle. CHARLIE");
    const second = r.dispatch("editor");
    expect(second.result).toStrictEqual({
      mode: "resume",
      text: `${CLOCK}\n\n${NOTE}\nOmkar: Trim the middle. CHARLIE\n\n(Reply to the conversation above as Editor.)`,
      send: { resumeCursor: "S1", recoveryText: r.full(second) },
    });
    // If the driver has to rebuild, it rebuilds from the whole turn.
    expect(second.result.send.recoveryText).toContain("Omkar: Cut the intro. ALPHA\nEditor: Intro cut. BRAVO\nOmkar: Trim the middle. CHARLIE");
    r.finish(second, "S1", { reply: "Middle trimmed. DELTA" });
    r.say("Tighten the outro. ECHO");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Tighten the outro. ECHO`);
  });

  it("keeps the tail, a card continuation included, on a delta", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Go on.");
    const tail = tailFor("editor", "\n\nThe person answered your question: yes.");
    const turn = r.dispatch("editor", { tail });
    expect(turn.result.mode).toBe("resume");
    expect(turn.result.text).toBe(`${CLOCK}\n\n${NOTE}\nOmkar: Go on.${tail}`);
  });

  it("puts the recalled block in front of the delta and of the recovery text alike", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("How long was it?");
    const recalled = "Recalled for this message:\n- the intro is 12s";
    const turn = r.dispatch("editor", { wrap: wrapWith(recalled) });
    expect(turn.result.text.startsWith(`${CLOCK}\n\n${recalled}\n\n${NOTE}\nOmkar: How long was it?`)).toBe(true);
    expect(turn.result.send.recoveryText!.startsWith(`${CLOCK}\n\n${recalled}\n\nOmkar: Cut the intro.`)).toBe(true);
  });

  it("does not offer a member its own replies back, and offers another member's", () => {
    const r = room();
    const codex = engine("codex", "codex");
    r.say("Cut the intro.");
    r.run("editor", "S1", { reply: "Intro cut." });
    r.say("Writer, name it.");
    // Writer runs on another instance, so the editor's process is untouched.
    r.run("writer", "W1", { reply: "Call it Dawn." }, { instance: codex });
    r.say("Editor, use that.");
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    expect(r.body(turn)).toBe(`${NOTE}\nOmkar: Writer, name it.\nWriter: Call it Dawn.\nOmkar: Editor, use that.`);
  });

  it("offers a line that arrived while its turn ran once, on the next turn, marked as older", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const posted = "Deploy status: green. POSTED";
    r.run("editor", "S1", { reply: "Middle trimmed.", during: () => { r.botSays("writer", posted, { peerPost: {} }); } });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.mode).toBe("resume");
    const lines = r.body(next).split("\n");
    expect(lines[0]).toBe(NOTE);
    expect(lines[1]).toBe("(The first message is older than messages you have already seen.)");
    // Another bot's post keeps its provenance note in a delta.
    expect(lines[2]).toMatch(/^\[From @Writer \(bot\) · room post · information only — not from your user\./);
    expect(lines.slice(3)).toEqual([`Writer: ${posted}`, "Omkar: Tighten the outro."]);
    r.finish(next, "S1", { reply: "Outro tightened." });
    r.say("Export it.");
    const after = r.dispatch("editor");
    expect(after.result.text).not.toContain("POSTED");
    expect(r.body(after)).toBe(`${NOTE}\nOmkar: Export it.`);
  });

  it("offers a line that arrived between the window being read and the dispatch on the next turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const window = r.transcript.window("room", "Omkar", undefined, "editor");
    r.say("And fix the titles. LATE");
    const turn = r.dispatch("editor", { window });
    expect(r.body(turn)).toBe(`${NOTE}\nOmkar: Trim the middle.`);
    r.finish(turn, "S1", { reply: "Trimmed." });
    r.say("Next.");
    expect(r.body(r.dispatch("editor"))).toBe(
      `${NOTE}\n(The first message is older than messages you have already seen.)\nOmkar: And fix the titles. LATE\nOmkar: Next.`);
  });

  it("says none when nothing is new, as on the summary re-ask after its own turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1", { reply: "(pass)" });
    const reask = "\n\nYour last turn in this room ended without a final message to the room. Reply now with one short message.";
    const turn = r.dispatch("editor", { tail: tailFor("editor", reask) });
    expect(turn.result.mode).toBe("resume");
    expect(turn.result.text).toBe(`${CLOCK}\n\n${NONE}\n\n(Reply to the conversation above as Editor.)${reask}`);
  });

  it("never offers a settled turn's working notes, and they do not hold its record back", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Start.");
    r.run("editor", "S1", { notes: ["Let me look. NOTE", "Found it. NOTE"], reply: "Done 0." });
    // Far more rounds than a record keeps loose ids for. The writer's notes
    // sit between the lines the editor is shown and are hidden once the
    // writer's turn settles: left unfolded, they would hold the editor's
    // record at round one and it would be given up long before the end.
    for (let round = 1; round <= 120; round++) {
      r.say(`Writer, step ${round}.`);
      r.run("writer", "W1", { notes: ["Looking. NOTE", "Still looking. NOTE"], reply: `Writer did ${round}.` }, { instance: other });
      r.say(`Editor, step ${round}.`);
      const next = r.dispatch("editor");
      expect(next.result.mode, `round ${round}`).toBe("resume");
      expect(r.body(next), `round ${round}`).toBe(`${NOTE}\nOmkar: Writer, step ${round}.\nWriter: Writer did ${round}.\nOmkar: Editor, step ${round}.`);
      r.finish(next, "S1", { notes: ["Checking. NOTE"], reply: `Editor did ${round}.` });
    }
  });

  it("sends a whole window's worth as a delta, and starts again when the member missed more than that", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1");
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES; n++) r.say(`Line ${n}.`);
    const thirty = r.dispatch("editor");
    expect(thirty.result.mode).toBe("resume");
    expect(r.body(thirty).split("\n")).toEqual([NOTE, ...Array.from({ length: GROUP_CONTEXT_MESSAGES }, (_, n) => `Omkar: Line ${n}.`)]);
    r.finish(thirty, "S1", { reply: "Caught up." });
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES + 10; n++) r.say(`Later ${n}.`);
    const forty = r.dispatch("editor");
    // A delta with a hole in it is never sent: the window on today's call instead.
    expect(forty.result).toStrictEqual({ mode: "start", text: r.full(forty), send: {} });
    expect(forty.result.text).not.toContain("Later 9.");
    expect(forty.result.text).toContain("Omkar: Later 10.\n");
    // The warm session went on (no reset): it is recorded with this window.
    r.finish(forty, "S1", { reply: "Caught up again." });
    r.say("And now?");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: And now?`);
  });

  it("starts again when a line that scrolled out of the window was never shown", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    // Posted while the turn ran, then pushed out of the window by later lines.
    r.run("editor", "S1", { during: () => { r.botSays("writer", "MISSED mid-turn post", { peerPost: {} }); } });
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES; n++) r.say(`Line ${n}.`);
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("start");
    expect(turn.result.text).not.toContain("MISSED");
  });

  it("starts again when the window reaches behind the line its session's start left out", () => {
    const r = room();
    for (let n = 0; n < 35; n++) r.say(`Old ${n}.`);
    // A turn that has not settled yet: its ten lines are all readable.
    for (let n = 0; n < 10; n++) r.botSays("writer", `Working ${n}.`, { turnId: "writer-turn" });
    r.say("Editor?");
    const first = r.run("editor", "S1");
    expect(first.result.text).toContain("Omkar: Old 16.\n");
    expect(first.result.text).not.toContain("Old 15.");
    // The writer's turn settles: its ten notes are hidden from now on, so the
    // window slides back over lines the editor's session was never shown.
    const final = r.botSays("writer", "Writer's result.", { turnId: "writer-turn", turnTerminal: true });
    expect(r.messages.some((m) => m.id === final)).toBe(true);
    r.say("Editor again?");
    const second = r.dispatch("editor");
    expect(second.result.mode).toBe("start");
    expect(second.result.text).toContain("Omkar: Old 9.\n");
    expect(second.result.text).not.toContain("Old 8.");
  });

  it("starts again when the lines its record is anchored to are gone", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.messages.splice(0, r.messages.length);
    r.say("A new conversation.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: when a record is not trusted", () => {
  const ready = () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    return r;
  };

  it("starts fresh at the 90% reset or Compact now, and the next turn is a delta against the new session", () => {
    const r = ready();
    const reset = r.dispatch("editor", { reset: true });
    expect(reset.result).toStrictEqual({ mode: "start", text: r.full(reset), send: { sessionReset: true } });
    r.finish(reset, "S2", { reply: "Fresh." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send).toStrictEqual({ resumeCursor: "S2", recoveryText: r.full(next) });
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("starts again after a turn that did not complete ok", () => {
    const r = ready();
    const failed = r.dispatch("editor");
    expect(failed.result.mode).toBe("resume");
    r.finish(failed, "S1", { ok: false });
    r.say("Try again.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("starts again after a turn whose completion was never seen, whoever dispatches next", () => {
    for (const nextSpeaker of ["editor", "writer"]) {
      const r = ready();
      const lost = r.dispatch("editor");
      expect(lost.result.mode).toBe("resume");
      r.bind(lost);
      r.emit(lost, { type: "session.started", sessionId: "S1" });
      r.emit(lost, r.output);
      // timed out, stalled, cancelled in the handshake or rejected at dispatch:
      // no turn.completed reaches the fold
      r.say("Anyone?");
      if (nextSpeaker === "writer") r.run("writer", "W1", {}, { instance: engine("claude-2") });
      const next = r.dispatch("editor");
      expect(next.result.mode, nextSpeaker).toBe("start");
    }
  });

  it("does not take a late event of an abandoned turn for the turn that replaced it", () => {
    const r = ready();
    const lost = r.dispatch("editor");
    r.bind(lost);
    r.say("Anyone?");
    const next = r.dispatch("editor");
    expect(next.result.mode).toBe("start");
    r.bind(next);
    // The abandoned turn's events arrive late, under its own turn id. Taken
    // for the new turn, its completion would end that turn's bookkeeping early.
    r.emit(lost, { type: "session.started", sessionId: "S1" });
    r.emit(lost, r.output);
    r.emit(lost, { type: "turn.completed", ok: false });
    r.finish(next, "S2", { reply: "Here." });
    r.say("Still there?");
    const after = r.dispatch("editor");
    expect(after.result.send.resumeCursor).toBe("S2");
    expect(r.body(after)).toBe(`${NOTE}\nOmkar: Still there?`);
  });

  it("ignores events of another instance, and of another turn once its own is known", () => {
    const r = ready();
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.sessions.onEvent({ eventId: "x1", provider: "codex", providerInstanceId: "codex", threadId: "room", createdAt: "", turnId: turn.turnId, type: "turn.completed", ok: false } as RuntimeEvent);
    r.sessions.onEvent({ eventId: "x2", provider: "claudeAgent", providerInstanceId: "claude", threadId: "room", createdAt: "", turnId: "another-turn", type: "turn.completed", ok: false } as RuntimeEvent);
    r.sessions.onEvent({ eventId: "x3", provider: "claudeAgent", providerInstanceId: "claude", threadId: "elsewhere", createdAt: "", turnId: turn.turnId, type: "turn.completed", ok: false } as RuntimeEvent);
    r.emit(turn, { type: "session.started", sessionId: "S1" });
    r.emit(turn, r.output);
    r.botSays("editor", "Trimmed.", { turnId: turn.turnId, turnTerminal: true });
    r.emit(turn, { type: "turn.completed", ok: true });
    r.say("Next.");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Next.`);
  });

  it("starts again when anything in its standing configuration changed", () => {
    const base = ["You are Editor, a bot in the room \"Edit bay\".", "/work", { instanceId: "claude", model: "opus", effort: "high" }, "ask", { agents: { env: { OMB_SKILL_AUTHORING_ENABLED: "0" } } }];
    const changes: unknown[][] = [
      ["You are Editor, a bot in the room \"Cutting room\".", ...base.slice(1)],
      [base[0], "/elsewhere", ...base.slice(2)],
      [...base.slice(0, 2), { instanceId: "claude", model: "sonnet", effort: "high" }, ...base.slice(3)],
      [...base.slice(0, 2), { instanceId: "claude", model: "opus", effort: "low" }, ...base.slice(3)],
      [...base.slice(0, 2), { instanceId: "claude", model: "opus", effort: "high", variant: "1m" }, ...base.slice(3)],
      [...base.slice(0, 3), "full", base[4]],
      [...base.slice(0, 4), { agents: { env: { OMB_SKILL_AUTHORING_ENABLED: "1" } } }],
      [...base, "one more"],
    ];
    for (const changed of changes) {
      const r = room();
      r.say("Cut the intro.");
      r.run("editor", "S1", {}, { config: base });
      r.say("Trim the middle.");
      expect(r.dispatch("editor", { config: changed }).result.mode, JSON.stringify(changed)).toBe("start");
    }
    const same = room();
    same.say("Cut the intro.");
    same.run("editor", "S1", {}, { config: base });
    same.say("Trim the middle.");
    expect(same.dispatch("editor", { config: structuredClone(base) }).result.mode).toBe("resume");
  });

  it("is not managed when its configuration cannot be fingerprinted", () => {
    const r = ready();
    const cyclic: unknown[] = ["persona"];
    cyclic.push(cyclic);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const turn = r.dispatch("editor", { config: cyclic });
      expect(turn.result).toStrictEqual({ mode: "legacy", text: r.full(turn), send: {} });
    } finally { warn.mockRestore(); }
  });

  it("starts again on another instance, and on a reloaded instance of the same name", () => {
    const moved = ready();
    expect(moved.dispatch("editor", { instance: engine("claude-2") }).result.mode).toBe("start");
    const reloaded = ready();
    // same id, a new adapter: the old one's processes are gone with it
    expect(reloaded.dispatch("editor", { instance: engine("claude") }).result.mode).toBe("start");
    expect(ready().dispatch("editor").result.mode).toBe("resume");
  });

  it("lives as long as the driver keeps a quiet process, and no longer", () => {
    const within = ready();
    within.state.now += IDLE_MS;
    expect(within.dispatch("editor").result.mode).toBe("resume");
    const past = ready();
    past.state.now += IDLE_MS + 1;
    const turn = past.dispatch("editor");
    expect(turn.result).toStrictEqual({ mode: "start", text: past.full(turn), send: {} });
  });

  it("is gone after a restart", () => {
    const r = ready();
    r.restart();
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("is gone once its thread is forgotten", () => {
    const r = ready();
    r.sessions.forget("room");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: several members", () => {
  it("never resumes a member after another member's turn on the same instance", () => {
    const r = room();
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    const writer = r.run("writer", "W1");
    expect(writer.result.mode).toBe("start");
    r.say("Editor, use that.");
    // Claude keeps one process per thread, and the writer's turn replaced the
    // editor's: main starts a new session here, and so does this.
    const back = r.dispatch("editor");
    expect(back.result).toStrictEqual({ mode: "start", text: r.full(back), send: {} });
    r.finish(back, "E2", { reply: "Used it." });
    r.say("Editor, one more.");
    const again = r.dispatch("editor");
    expect(again.result.send.resumeCursor).toBe("E2");
    expect(r.body(again)).toBe(`${NOTE}\nOmkar: Editor, one more.`);
  });

  it("counts another member's unmanaged turn on the same instance too", () => {
    const r = room();
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    r.run("writer", "W1", {}, { guestConfined: true });
    r.say("Editor, use that.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("resumes a member after another member's turn on a different instance", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    expect(r.run("writer", "W1", { reply: "Dawn." }, { instance: other }).result.mode).toBe("start");
    r.say("Editor, use that.");
    const back = r.dispatch("editor");
    expect(back.result.send.resumeCursor).toBe("E1");
    expect(r.body(back)).toBe(`${NOTE}\nOmkar: Writer, name it.\nWriter: Dawn.\nOmkar: Editor, use that.`);
    r.finish(back, "E1", { reply: "Used it." });
    // and the writer, alone on its instance, resumes its own session
    r.say("Writer, thanks.");
    const writer = r.dispatch("writer", { instance: other });
    expect(writer.result.send.resumeCursor).toBe("W1");
    expect(r.body(writer)).toBe(`${NOTE}\nOmkar: Editor, use that.\nEditor: Used it.\nOmkar: Writer, thanks.`);
  });

  it("leaves another member's record alone when one member's turn ends cleanly or badly", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor?");
    r.run("editor", "E1");
    r.say("Writer?");
    r.run("writer", "W1", {}, { instance: other });
    r.say("Writer again?");
    const failed = r.dispatch("writer", { instance: other });
    r.finish(failed, "W1", { ok: false });
    r.say("Editor again?");
    expect(r.dispatch("editor").result.mode).toBe("resume");
  });

  it("trusts neither member when two are recorded with one native session", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor?");
    r.run("editor", "SHARED");
    r.say("Writer?");
    r.run("writer", "SHARED", {}, { instance: other });
    r.say("Editor again?");
    expect(r.dispatch("editor").result.mode).toBe("start");
    r.say("Writer again?");
    expect(r.dispatch("writer", { instance: other }).result.mode).toBe("start");
  });

  it("keeps the threads of one room apart", () => {
    const first = room({ threadId: "thread-1" });
    const second = room({ threadId: "thread-2", shared: { messages: first.threads, sessions: first.sessions } });
    first.say("Thread one. ONE");
    first.run("editor", "T1");
    second.say("Thread two. TWO");
    const opening = second.dispatch("editor");
    expect(opening.result.mode).toBe("start");
    expect(opening.result.text).not.toContain("ONE");
    second.finish(opening, "T2", { reply: "Two it is." });
    first.say("More for one.");
    const one = first.dispatch("editor");
    expect(one.result.send.resumeCursor).toBe("T1");
    expect(first.body(one)).toBe(`${NOTE}\nOmkar: More for one.`);
    second.say("More for two.");
    const two = second.dispatch("editor");
    expect(two.result.send.resumeCursor).toBe("T2");
    expect(two.result.text).not.toContain("ONE");
  });
});

describe("room sessions: the session a turn really ran in", () => {
  it("records the warm session a start went on in, since a start does not reset", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const failed = r.dispatch("editor");
    r.finish(failed, "S1", { ok: false });
    r.say("Try again.");
    const start = r.dispatch("editor");
    expect(start.result.send).toStrictEqual({});
    // the driver's process survived, so the turn ran in S1 again
    r.finish(start, "S1", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("records nothing for a start whose session was never announced", () => {
    const r = room();
    r.say("Cut the intro.");
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.emit(turn, r.output);
    r.emit(turn, { type: "turn.completed", ok: true });
    r.say("Trim the middle.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("credits the session a driver rebuilt from the recovery text with the window", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const refused = r.dispatch("editor");
    expect(refused.result.send.resumeCursor).toBe("S1");
    // the driver could not reopen S1 and went on in S2, from recoveryText
    r.finish(refused, "S2", { rebuilt: true, reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S2");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("credits nothing to a session that replaced the cursor without saying it was rebuilt", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const breached = r.dispatch("editor");
    r.finish(breached, "S-surprise", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("does not record a turn the provider never acted on", () => {
    const r = room();
    r.say("Cut the intro.");
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.emit(turn, { type: "session.started", sessionId: "S1" });
    r.emit(turn, { type: "item.completed", itemType: "assistant_text", text: "API Error: 529", synthetic: true });
    r.emit(turn, { type: "turn.completed", ok: false });
    r.say("Again.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: a native compaction", () => {
  const ready = () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    return r;
  };

  it("is not managed without the engine-hook channel, which is how a compaction is heard of", () => {
    const r = ready();
    const turn = r.dispatch("editor", { hooks: false });
    expect(turn.result).toStrictEqual({ mode: "legacy", text: r.full(turn), send: {} });
    r.finish(turn, "S1", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    // and the record it had is gone: nothing said whether that turn compacted
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("drops the record of a member whose session the engine compacted between its turns", () => {
    const r = ready();
    r.sessions.distrust("room", "editor");
    const turn = r.dispatch("editor");
    expect(turn.result).toStrictEqual({ mode: "start", text: r.full(turn), send: {} });
  });

  it("does not trust a turn again that compacted while it ran, though it completed ok", () => {
    const r = ready();
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    // PreCompact and SessionStart(compact) arrive mid-turn; the session now
    // holds the CLI's summary in place of the room's lines.
    r.finish(turn, "S1", { reply: "Trimmed.", during: () => { r.sessions.distrust("room", "editor"); r.sessions.distrust("room", "editor"); } });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
    expect(next.result.text).toContain("Omkar: Cut the intro.");
    // The start is recorded like any other: the turn after it is a delta again.
    r.finish(next, "S1", { reply: "Tightened." });
    r.say("Export it.");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Export it.`);
  });

  it("does not trust a start that compacted while it ran", () => {
    const r = room();
    r.say("Cut the intro.");
    const turn = r.dispatch("editor");
    r.finish(turn, "S1", { reply: "Done.", during: () => { r.sessions.distrust("room", "editor"); } });
    r.say("Trim the middle.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("does not trust a turn whose session compacted before its first output either", () => {
    // The CLI compacts as the turn begins, before the model says anything:
    // nothing the turn goes on to do may put a record back.
    const start = room();
    start.say("Cut the intro.");
    start.finish(start.dispatch("editor"), "S1", { reply: "Done.", before: () => { start.sessions.distrust("room", "editor"); } });
    expect(start.sessions.tracked()).toMatchObject({ records: 0, flights: 0 });
    start.say("Trim the middle.");
    const afterStart = start.dispatch("editor");
    expect(afterStart.result).toStrictEqual({ mode: "start", text: start.full(afterStart), send: {} });

    const resumed = ready();
    const turn = resumed.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    resumed.finish(turn, "S1", { reply: "Trimmed.", before: () => { resumed.sessions.distrust("room", "editor"); } });
    expect(resumed.sessions.tracked()).toMatchObject({ records: 0, flights: 0 });
    resumed.say("Tighten the outro.");
    expect(resumed.dispatch("editor").result.mode).toBe("start");

    // a session the driver rebuilt from the whole turn, and that then compacted
    const rebuilt = ready();
    rebuilt.finish(rebuilt.dispatch("editor"), "S2", { rebuilt: true, reply: "Trimmed.", before: () => { rebuilt.sessions.distrust("room", "editor"); } });
    rebuilt.say("Tighten the outro.");
    expect(rebuilt.dispatch("editor").result.mode).toBe("start");
  });

  it("leaves another member's record, and another thread's, alone", () => {
    const r = ready();
    r.sessions.distrust("room", "writer");
    r.sessions.distrust("another-thread", "editor");
    expect(r.dispatch("editor").result.mode).toBe("resume");
  });

  it("starts instead of resuming a session that is close to the engine's own compaction", () => {
    // 80% of the threshold the engine compacts at (Claude's --autocompact window).
    const near = ready();
    expect(near.dispatch("editor", { context: () => ({ tokens: 160_000, window: 1_000_000, compactAt: 200_000 }) }).result.mode).toBe("start");
    const below = ready();
    expect(below.dispatch("editor", { context: () => ({ tokens: 159_999, window: 1_000_000, compactAt: 200_000 }) }).result.mode).toBe("resume");
    // "auto" and "off" give no number: the model's window is the only bound known.
    for (const compactAt of [Number.NaN, 0, undefined]) {
      const auto = ready();
      expect(auto.dispatch("editor", { context: () => ({ tokens: 160_000, window: 200_000, compactAt }) }).result.mode, String(compactAt)).toBe("start");
      const under = ready();
      expect(under.dispatch("editor", { context: () => ({ tokens: 159_999, window: 200_000, compactAt }) }).result.mode, String(compactAt)).toBe("resume");
    }
    // No reading at all (the turn reported no usage): nothing to compare.
    expect(ready().dispatch("editor", { context: () => ({ compactAt: 200_000 }) }).result.mode).toBe("resume");
    expect(ready().dispatch("editor", { context: () => undefined }).result.mode).toBe("resume");
    expect(ready().dispatch("editor", { context: undefined }).result.mode).toBe("resume");
    // The reading is not asked for where it could not matter: a member's
    // first turn here, and a turn that is not managed.
    const asked = vi.fn(() => ({ tokens: 1, window: 200_000 }));
    const first = room();
    first.say("Cut the intro.");
    first.dispatch("editor", { context: asked });
    ready().dispatch("editor", { context: asked, hooks: false });
    expect(asked).not.toHaveBeenCalled();
    // Once per turn after that, for both rules that read it.
    ready().dispatch("editor", { context: asked });
    expect(asked).toHaveBeenCalledOnce();
  });
});

// The second signal for a compaction, for when the engine's hook never
// arrives: within one native session a member's measured context only grows
// from one turn's end to the next.
describe("room sessions: a measured context that went down", () => {
  const reading = (tokens?: number) => ({ context: () => (tokens === undefined ? undefined : { tokens, window: 1_000_000 }) });
  /** Editor's first turn (S1), then a second that saw `tokens` after the first. */
  const two = (tokens?: number) => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const second = r.dispatch("editor", reading(tokens));
    expect(second.result.mode).toBe("resume");
    r.finish(second, "S1", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    return r;
  };

  it("starts when the reading is lower than at the member's previous turn in the same session", () => {
    const r = two(90_000);
    const turn = r.dispatch("editor", reading(30_000));
    expect(turn.result).toStrictEqual({ mode: "start", text: r.full(turn), send: {} });
    // the record went with it, as for any distrust
    expect(r.sessions.tracked()).toMatchObject({ records: 0 });
  });

  it("leaves the other rules to decide when the reading is equal or grew", () => {
    expect(two(90_000).dispatch("editor", reading(90_000)).result.mode).toBe("resume");
    expect(two(90_000).dispatch("editor", reading(90_001)).result.mode).toBe("resume");
    // and they still decide: a reset is a start whatever the reading says
    expect(two(90_000).dispatch("editor", { ...reading(120_000), reset: true }).result.mode).toBe("start");
  });

  it("takes a reading that is missing on either side for no signal", () => {
    // none now
    expect(two(90_000).dispatch("editor", reading(undefined)).result.mode).toBe("resume");
    expect(two(90_000).dispatch("editor").result.mode).toBe("resume");
    // none before
    expect(two(undefined).dispatch("editor", reading(30_000)).result.mode).toBe("resume");
    // and a missing one in between does not hide a fall across it
    const r = two(90_000);
    const third = r.dispatch("editor", reading(undefined));
    expect(third.result.mode).toBe("resume");
    r.finish(third, "S1", { reply: "Tightened." });
    r.say("Export it.");
    expect(r.dispatch("editor", reading(30_000)).result.mode).toBe("start");
  });

  it("catches a compaction whose hook never arrived: the turn after it is a start", () => {
    const r = room();
    r.say("Cut the intro. ALPHA");
    r.run("editor", "S1", { reply: "Intro cut." });
    // turns 2..n resume S1 with deltas while its context grows
    for (const [n, tokens] of [40_000, 90_000, 150_000].entries()) {
      r.say(`Step ${n}.`);
      const turn = r.dispatch("editor", reading(tokens));
      expect(r.body(turn), `step ${n}`).toBe(`${NOTE}\nOmkar: Step ${n}.`);
      r.finish(turn, "S1", { reply: `Did ${n}.` });
    }
    // During that last turn the CLI compacted S1. No PreCompact, no
    // SessionStart(compact) reached the harness: distrust was never called.
    // The turn completed ok; its reading is what the summary weighs.
    r.say("And now?");
    const after = r.dispatch("editor", reading(25_000));
    expect(after.result).toStrictEqual({ mode: "start", text: r.full(after), send: {} });
    expect(after.result.text).toContain("Omkar: Cut the intro. ALPHA\nEditor: Intro cut.");
    // The warm session goes on (no reset) and is recorded with the window:
    // from here its context grows again, and so do the deltas.
    r.finish(after, "S1", { reply: "Here." });
    r.say("Next.");
    const next = r.dispatch("editor", reading(40_000));
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Next.`);
  });

  it("catches one that happened on a start which went on in the same warm session", () => {
    const r = two(90_000);
    // the turn fails, so the next is a start; the driver's process survived
    const failed = r.dispatch("editor", reading(120_000));
    r.finish(failed, "S1", { ok: false });
    r.say("Try again.");
    const start = r.dispatch("editor", reading(130_000));
    expect(start.result.mode).toBe("start");
    // it runs in S1 again, and S1 compacts while it does, unseen
    r.finish(start, "S1", { reply: "Tightened." });
    r.say("Export it.");
    expect(r.dispatch("editor", reading(20_000)).result.mode).toBe("start");
  });

  it("does not take a new session's smaller context for a fall", () => {
    // Another member's turn takes the process: the editor's next turn starts
    // a new session, whose context is of course smaller than the old one's.
    const r = two(90_000);
    r.run("writer", "W1");
    r.say("Editor, again.");
    const back = r.dispatch("editor", reading(120_000));
    expect(back.result.mode).toBe("start");
    r.finish(back, "S2", { reply: "Back." });
    r.say("Editor, once more.");
    const next = r.dispatch("editor", reading(15_000));
    expect(next.result.send.resumeCursor).toBe("S2");
    // and from there the comparison is within S2
    r.finish(next, "S2", { reply: "Again." });
    r.say("Editor, last one.");
    expect(r.dispatch("editor", reading(9_000)).result.mode).toBe("start");
  });

  it("does not compare against a turn that was never seen to end, or was not managed", () => {
    const lost = two(90_000);
    const abandoned = lost.dispatch("editor", reading(100_000));
    lost.bind(abandoned);
    lost.say("Anyone?");
    // a start anyway (the record went with the abandoned turn); what matters
    // is that the reading it sees is not held against a later session
    lost.finish(lost.dispatch("editor", reading(100_000)), "S9", { reply: "Here." });
    lost.say("Still there?");
    expect(lost.dispatch("editor", reading(10_000)).result.send.resumeCursor).toBe("S9");

    const confined = two(90_000);
    confined.finish(confined.dispatch("editor", { ...reading(100_000), guestConfined: true }), "S-guest", { reply: "Confined." });
    confined.say("Back to normal.");
    confined.finish(confined.dispatch("editor", reading(100_000)), "S1", { reply: "Here." });
    confined.say("And again.");
    expect(confined.dispatch("editor", reading(100_000)).result.send.resumeCursor).toBe("S1");
  });

  it("keeps what it knew of a session across a turn it did not manage, without trusting that turn's reading", () => {
    // S1 was last seen at 90,000. A guest's turn then runs somewhere the
    // module does not follow and leaves its own small reading behind.
    const r = two(90_000);
    r.finish(r.dispatch("editor", { ...reading(90_000), guestConfined: true }), "S-guest", { reply: "Confined." });
    r.say("Back to normal.");
    // That reading is the guest session's: it says nothing about S1, and is
    // not taken for S1's new size either.
    const back = r.dispatch("editor", reading(5_000));
    expect(back.result.mode).toBe("start");
    // The start goes on in S1, which compacts while it runs, unseen.
    r.finish(back, "S1", { reply: "Here." });
    r.say("And again.");
    // 40,000 is lower than the 90,000 S1 was last seen at: a start.
    const next = r.dispatch("editor", reading(40_000));
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });
});

describe("room sessions: a line that changed after it was shown", () => {
  const digestOf = (reply: string, files?: string[]) => ({
    turnId: "t", botId: "writer", threadId: "room", at: 1, durationMs: 100, tools: [], memory: [], reply, hookCoverage: "none" as const,
    ...(files ? { files: { changed: files, added: [], deleted: [] } } : {}),
  });

  it("sends a digest row again once it gained its file list, marked as replacing what was shown", () => {
    const r = room();
    r.say("Cut the intro.");
    const digest = r.add({ role: "bot", kind: "digest", text: "[digest]", from: { botId: "writer", name: "Writer", color: "blue" }, digest: digestOf("Cut.") });
    r.say("Editor, check it.");
    const first = r.run("editor", "S1");
    expect(first.result.text).toContain("[What Writer did in an earlier turn: · no tool activity observed in this turn · reply: Cut.]");
    // The folder diff lands up to three seconds after the row was appended.
    r.messages.find((m) => m.id === digest)!.digest = digestOf("Cut.", ["intro.mov"]);
    r.say("And now?");
    const second = r.dispatch("editor");
    expect(second.result.mode).toBe("resume");
    expect(r.body(second)).toBe([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      "[What Writer did in an earlier turn: · no tool activity observed in this turn · files: changed intro.mov · reply: Cut.]",
      "Omkar: And now?",
    ].join("\n"));
    // Once: the session holds the row as it reads now.
    r.finish(second, "S1", { reply: "Checked." });
    r.say("Again?");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Again?`);
  });

  it("sends a teammate's report again when it no longer reads as it did", () => {
    const r = room();
    r.say("Writer, name the film.");
    r.add({ role: "bot", kind: "activity", roomRequest: { id: "request-1", phase: "result" } });
    r.say("Editor, use it.");
    const first = r.run("editor", "S1");
    expect(first.result.text).toContain("[report request-1]");
    // The row holds no text of its own: it is rendered from the request's
    // state, and that state moved (settled again, renamed, withheld).
    r.reports.set("request-1", "[Teammate result withheld or no longer retained]");
    r.say("And now?");
    const second = r.dispatch("editor");
    expect(r.body(second)).toBe([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      "[Teammate result withheld or no longer retained]",
      "Omkar: And now?",
    ].join("\n"));
    r.finish(second, "S1", { reply: "Noted." });
    r.say("Again?");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Again?`);
  });

  it("does not send an unchanged row again, however often the window is read", () => {
    const r = room();
    r.say("Writer, name the film.");
    r.add({ role: "bot", kind: "activity", roomRequest: { id: "request-1", phase: "result" } });
    r.add({ role: "bot", kind: "digest", text: "[digest]", from: { botId: "writer", name: "Writer", color: "blue" }, digest: digestOf("Named.") });
    r.say("Editor, use it.");
    r.run("editor", "S1");
    for (let n = 0; n < 5; n++) {
      r.say(`Step ${n}.`);
      const turn = r.dispatch("editor");
      expect(r.body(turn), `step ${n}`).toBe(`${NOTE}\nOmkar: Step ${n}.`);
      r.finish(turn, "S1", { reply: `Did ${n}.` });
    }
  });

  it("sends a changed line a delta showed, not only one a start showed", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1");
    const said = r.say("Use the blue grade.");
    const delta = r.run("editor", "S1");
    expect(r.body(delta)).toBe(`${NOTE}\nOmkar: Use the blue grade.`);
    r.messages.find((m) => m.id === said)!.text = "Use the teal grade.";
    r.say("Go.");
    expect(r.body(r.dispatch("editor"))).toBe(
      `${NOTE}\n(The first message was shown to you before and has changed since: this copy replaces what you were shown.)\nOmkar: Use the teal grade.\nOmkar: Go.`);
  });

  it("sends a changed line together with one that arrived while its turn ran, each under its own sentence", () => {
    const r = room();
    const first = r.say("Use the blue grade.");
    r.run("editor", "S1");
    r.say("Go.");
    r.run("editor", "S1", { reply: "Graded.", during: () => { r.botSays("writer", "Deploy is green.", { peerPost: {} }); } });
    r.messages.find((m) => m.id === first)!.text = "Use the teal grade.";
    r.say("Next.");
    const lines = r.body(r.dispatch("editor")).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      "Omkar: Use the teal grade.",
      "(The next message is older than messages you have already seen.)",
    ]);
    expect(lines[4]).toMatch(/^\[From @Writer \(bot\) · room post/);
    expect(lines.slice(5)).toEqual(["Writer: Deploy is green.", "Omkar: Next."]);
  });

  it("takes a member's own reply as it reads when it first appears, and sends it if it changes after that", () => {
    const r = room();
    r.say("Say it out loud.");
    const first = r.dispatch("editor");
    const reply = r.finish(first, "S1", { reply: "Here is the note." })!;
    // the voice note's transcript is added to the reply as the turn settles
    r.messages.find((m) => m.id === reply)!.text = "Here is the note.\n\nGood morning, team.";
    r.say("Thanks.");
    const second = r.dispatch("editor");
    // its own words are not offered back
    expect(r.body(second)).toBe(`${NOTE}\nOmkar: Thanks.`);
    r.finish(second, "S1", { reply: "Welcome." });
    // edited later, by something other than the session
    r.messages.find((m) => m.id === reply)!.text = "Here is the note.\n\n[transcript removed]";
    r.say("And now?");
    expect(r.body(r.dispatch("editor"))).toBe([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      "Editor: Here is the note.\n\n[transcript removed]",
      "Omkar: And now?",
    ].join("\n"));
  });

  it("sends the latest line again once it reads with its attachment tag, as the window shows it from then on", () => {
    const r = room();
    const latest = r.say('Use this frame <attached-image path="/tmp/frame.png" />');
    // the turn that carries the image natively reads the line without the tag
    const window = r.transcript.window("room", "Omkar", [{ messageId: latest, text: "Use this frame" }], "editor");
    const first = r.dispatch("editor", { window });
    expect(first.result.text).toContain("Omkar: Use this frame\n");
    r.finish(first, "S1", { reply: "Used." });
    r.say("And the next one?");
    expect(r.body(r.dispatch("editor"))).toBe([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      'Omkar: Use this frame <attached-image path="/tmp/frame.png" />',
      "Omkar: And the next one?",
    ].join("\n"));
  });

  it("re-reads nothing of a line that changed after it scrolled out of the window", () => {
    const r = room();
    const old = r.say("Use the blue grade.");
    r.run("editor", "S1");
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES - 1; n++) r.say(`Line ${n}.`);
    r.messages.find((m) => m.id === old)!.text = "Use the teal grade.";
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    // not in today's window, so not part of what a turn carries, here or on main
    expect(turn.result.text).not.toContain("grade");
  });
});

describe("room sessions: the session a turn ended in", () => {
  it("does not trust a record when the driver announced another session after the provider had acted", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const turn = r.dispatch("editor");
    expect(turn.result.send.resumeCursor).toBe("S1");
    // accepted in S1, then relaunched into S2: what S2 holds is unknown, and
    // the replies that follow were written there, not in S1
    r.finish(turn, "S1", { reply: "Trimmed.", switchTo: "S2" });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("does not trust a start that ended in another session than the one it was accepted in", () => {
    const r = room();
    r.say("Cut the intro.");
    r.finish(r.dispatch("editor"), "S1", { reply: "Done.", switchTo: "S2" });
    r.say("Trim the middle.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("does not trust a resumed turn whose session was never announced", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    r.bind(turn);
    r.emit(turn, r.output);
    r.botSays("editor", "Trimmed.", { turnId: turn.turnId, turnTerminal: true });
    r.emit(turn, { type: "turn.completed", ok: true });
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("still trusts a turn that re-announced its own session", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    r.finish(r.dispatch("editor"), "S1", { reply: "Trimmed.", switchTo: "S1" });
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.send.resumeCursor).toBe("S1");
  });
});

describe("room sessions: what it keeps, and that it cannot fail a turn", () => {
  it("keeps nothing while the setting is off, and drops what it held when it is switched off", () => {
    const first = room({ threadId: "thread-1" });
    const second = room({ threadId: "thread-2", shared: { messages: first.threads, sessions: first.sessions } });
    first.say("One.");
    first.run("editor", "T1");
    second.say("Two.");
    second.run("writer", "T2");
    expect(first.sessions.tracked()).toMatchObject({ records: 2, flights: 0, speakers: 2, readings: 2 });
    expect(first.sessions.tracked().lines).toBeGreaterThan(0);
    first.state.enabled = false;
    // one turn anywhere sees the setting off, and everything is let go
    second.say("More.");
    const off = second.dispatch("writer");
    expect(off.result.mode).toBe("legacy");
    expect(first.sessions.tracked()).toEqual({ records: 0, flights: 0, speakers: 0, lines: 0, readings: 0 });
    second.finish(off, "T2", { reply: "Ok." });
    expect(first.sessions.tracked()).toEqual({ records: 0, flights: 0, speakers: 0, lines: 0, readings: 0 });
    first.state.enabled = true;
    first.say("More for one.");
    expect(first.dispatch("editor").result.mode).toBe("start");
  });

  it("fingerprints nothing while the setting is off", () => {
    const r = room();
    r.state.enabled = false;
    r.say("Cut the intro.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A structure JSON cannot take would throw if it were read.
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);
      const turn = r.dispatch("editor", { config: cyclic });
      expect(turn.result).toStrictEqual({ mode: "legacy", text: r.full(turn), send: {} });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("lets go of records, speakers and abandoned turns once they are older than a session lives", () => {
    const first = room({ threadId: "thread-1" });
    const second = room({ threadId: "thread-2", shared: { messages: first.threads, sessions: first.sessions } });
    const third = room({ threadId: "thread-3", shared: { messages: first.threads, sessions: first.sessions } });
    first.say("One.");
    first.run("editor", "T1");
    // a turn on another thread that is never seen to end, in a room nobody returns to
    second.say("Two.");
    const abandoned = second.dispatch("writer");
    second.bind(abandoned);
    second.emit(abandoned, { type: "session.started", sessionId: "T2" });
    second.emit(abandoned, second.output);
    expect(first.sessions.tracked()).toMatchObject({ records: 2, flights: 1, speakers: 2 });

    // Ten quiet minutes later, a turn somewhere else. The settled member's
    // record and its place as last speaker are past their life. Its last
    // reading is not: a driver may keep the process longer than that, and
    // the reading is what shows a compaction on a start that went on in it.
    // Nothing of the member whose turn is still running is touched: its
    // record and its place as last speaker stay.
    first.state.now += IDLE_MS + 1;
    third.say("Three.");
    third.run("scout", "T3");
    // (records: the running turn's and scout's; speakers: the same two; readings: editor's and scout's)
    expect(first.sessions.tracked()).toMatchObject({ records: 2, flights: 1, speakers: 2, readings: 2 });

    // A day on, the turn that never ended is given up, and all it held with
    // it; a reading lives a little longer than that (longer than any process
    // the driver could still be holding), and no longer.
    first.state.now += DAY + 1;
    third.say("Three again.");
    const later = third.dispatch("scout");
    expect(later.result.mode).toBe("start");
    // (what is left of the two quiet members: their readings)
    expect(first.sessions.tracked()).toEqual({ records: 0, flights: 1, speakers: 1, lines: 0, readings: 2 });
    third.finish(later, "T3", { reply: "Here." });
    first.state.now += READING_LIFE + 1;
    third.say("Three once more.");
    expect(third.dispatch("scout").result.mode).toBe("start");
    expect(first.sessions.tracked()).toEqual({ records: 0, flights: 1, speakers: 1, lines: 0, readings: 0 });
  });

  it("remembers how no more lines read than a window holds, however long the room runs", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1", { notes: ["Looking.", "Still looking."] });
    let most = 0;
    for (let turn = 0; turn < 100; turn++) {
      for (let n = 0; n < 4; n++) r.say(`Line ${turn}.${n}.`);
      const next = r.dispatch("editor");
      expect(next.result.mode).toBe("resume");
      r.finish(next, "S1", { notes: ["Looking.", "Still looking."], reply: `Did ${turn}.` });
      most = Math.max(most, r.sessions.tracked().lines);
    }
    // the window's lines, and the three the last turn wrote itself
    expect(most).toBeLessThanOrEqual(GROUP_CONTEXT_MESSAGES + 3);
    expect(most).toBeGreaterThan(GROUP_CONTEXT_MESSAGES / 2);
  });

  it("cannot fail the event fold either: a fault there forgets the thread, and its next turn is a start", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    r.bind(turn);
    r.emit(turn, { type: "session.started", sessionId: "S1" });
    // the store fails while the provider's first output is being credited
    const messages = r.threads.get("room")!;
    r.threads.set("room", new Proxy(messages, { get() { throw new Error("the store gave way"); } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => r.emit(turn, r.output)).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      r.threads.set("room", messages);
    }
    expect(r.sessions.tracked()).toEqual({ records: 0, flights: 0, speakers: 0, lines: 0, readings: 0 });
    // the rest of the turn is nobody's, and the next one starts
    r.botSays("editor", "Trimmed.", { turnId: turn.turnId, turnTerminal: true });
    expect(() => r.emit(turn, { type: "turn.completed", ok: true })).not.toThrow();
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("answers with today's call if anything in it throws, and drops the member's record", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const window = r.transcript.window("room", "Omkar", undefined, "editor");
    const broken = { ...window, get order(): string[] { throw new Error("a bug in the module's own bookkeeping"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const turn = r.dispatch("editor", { window: broken });
      expect(turn.result).toStrictEqual({ mode: "legacy", text: r.full(turn), send: {} });
      expect(warn).toHaveBeenCalledOnce();
      // the room's own reset still goes out with the fallback
      const withReset = r.dispatch("editor", { window: broken, reset: true });
      expect(withReset.result).toStrictEqual({ mode: "legacy", text: r.full(withReset), send: { sessionReset: true } });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
    expect(r.sessions.tracked()).toMatchObject({ records: 0, flights: 0 });
    // and the next turn is an ordinary start
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

// Quiet is measured from when a member's turn ended, and nothing a running
// turn's settle will need is let go while the turn runs, whoever dispatches
// elsewhere meanwhile (every dispatch prunes).
describe("room sessions: long turns, and turns in other rooms meanwhile", () => {
  const reading = (tokens?: number) => ({ context: () => (tokens === undefined ? undefined : { tokens, window: 1_000_000 }) });
  /** Two rooms on one tracker: the editor's, and another where a turn is dispatched now and then. */
  const rooms = () => {
    const r = room({ threadId: "room" });
    const other = room({ threadId: "other", shared: { messages: r.threads, sessions: r.sessions } });
    const elsewhere = () => { other.say("Hello."); other.run("scout", "X1", {}, { instance: engine("claude-2") }); };
    return { r, elsewhere };
  };
  const ready = () => {
    const both = rooms();
    both.r.say("Cut the intro. ALPHA");
    both.r.run("editor", "S1", { reply: "Intro cut." });
    both.r.say("Trim the middle.");
    return both;
  };

  it("resumes after a long turn that was answered soon after it settled", () => {
    // a 6-minute turn answered 5 minutes after it settled: 11 since its dispatch
    const { r } = ready();
    r.finish(r.dispatch("editor"), "S1", { reply: "Trimmed.", during: () => { r.state.now += 6 * MIN; } });
    r.state.now += 5 * MIN;
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("resumes after a turn that itself ran longer than a quiet process is kept", () => {
    const { r, elsewhere } = ready();
    r.finish(r.dispatch("editor"), "S1", {
      reply: "Trimmed.",
      before: () => { r.state.now += 7 * MIN; elsewhere(); },
      during: () => { r.state.now += 7 * MIN; elsewhere(); },
    });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("starts when a turn is answered more than the idle life after it settled, however long it ran", () => {
    for (const ran of [0, 6 * MIN, 12 * MIN]) {
      const within = ready().r;
      within.finish(within.dispatch("editor"), "S1", { reply: "Trimmed.", during: () => { within.state.now += ran; } });
      within.state.now += IDLE_MS;
      within.say("Tighten the outro.");
      expect(within.dispatch("editor").result.mode, `ran ${ran}`).toBe("resume");

      const past = ready().r;
      past.finish(past.dispatch("editor"), "S1", { reply: "Trimmed.", during: () => { past.state.now += ran; } });
      past.state.now += IDLE_MS + 1;
      past.say("Tighten the outro.");
      const turn = past.dispatch("editor");
      expect(turn.result, `ran ${ran}`).toStrictEqual({ mode: "start", text: past.full(turn), send: {} });
    }
  });

  it("keeps a member's last reading while its turn runs: a lost hook is still caught", () => {
    // The reviewer's sequence. Turn 2 settles at T0 with the hook channel on.
    const { r, elsewhere } = ready();
    r.finish(r.dispatch("editor", reading(60_000)), "S1", { reply: "Trimmed." });
    const T0 = r.state.now;
    // T0 + 9 min: the next turn is dispatched as a delta on S1; its reading is 120k.
    r.state.now = T0 + 9 * MIN;
    r.say("Tighten the outro, slowly.");
    const long = r.dispatch("editor", reading(120_000));
    expect(long.result.send.resumeCursor).toBe("S1");
    r.finish(long, "S1", {
      reply: "Tightened.",
      during: () => {
        // T0 + 10.5 min: a turn is dispatched in another room.
        r.state.now = T0 + 10.5 * MIN;
        elsewhere();
        // S1 compacts while the turn runs; neither hook arrives.
        r.state.now = T0 + 12 * MIN;
      },
    });
    // T0 + 13 min: the reading fell from 120k to 25k.
    r.state.now = T0 + 13 * MIN;
    r.say("Export it. CHARLIE");
    const next = r.dispatch("editor", reading(25_000));
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
    expect(next.result.text).toContain("Omkar: Cut the intro. ALPHA");
  });

  it("keeps record and reading from the dispatch on, before the provider has acted", () => {
    // The turn waits on its engine past the idle life before it says a word,
    // and other rooms dispatch meanwhile.
    const waited = (after: number) => {
      const { r, elsewhere } = ready();
      r.finish(r.dispatch("editor", reading(60_000)), "S1", { reply: "Trimmed." });
      r.state.now += 9 * MIN;
      r.say("Tighten the outro, slowly.");
      const long = r.dispatch("editor", reading(120_000));
      r.state.now += 2 * MIN;
      elsewhere();
      r.finish(long, "S1", { reply: "Tightened.", before: () => { r.state.now += 2 * MIN; elsewhere(); } });
      r.say("Export it.");
      return { r, next: r.dispatch("editor", reading(after)) };
    };
    // Its record survived the wait: with a context that grew, a delta.
    const grew = waited(130_000);
    expect(grew.next.result.send.resumeCursor).toBe("S1");
    expect(grew.r.body(grew.next)).toBe(`${NOTE}\nOmkar: Export it.`);
    // And so did its last reading: with a context that fell, a start.
    expect(waited(25_000).next.result.mode).toBe("start");
  });

  it("keeps the record of a turn in flight, so none is made up for a session that was sent only a delta", () => {
    // A resume flight whose record went missing before the provider acted
    // would get a new one from Handoffs. Nothing lets go of it while its
    // turn runs (pruning skips it, and whatever else drops it ends or bars
    // the flight too), so the record a delta is credited to is the one the
    // session's earlier turns built.
    const { r, elsewhere } = ready();
    const report = r.add({ role: "bot", kind: "activity", roomRequest: { id: "request-1", phase: "result" } });
    r.say("Editor, read it.");
    r.finish(r.dispatch("editor"), "S1", { reply: "Read." });
    r.say("Tighten the outro.");
    const turn = r.dispatch("editor");
    expect(r.body(turn)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
    const held = r.sessions.tracked();
    // the editor's record is long past its life before the provider says a word
    r.state.now += IDLE_MS + 1;
    elsewhere();
    expect(r.sessions.tracked()).toMatchObject({ records: held.records + 1, lines: held.lines + 2 });
    r.finish(turn, "S1", { reply: "Tightened." });
    // The record is still the session's own: the next turn is a delta, and it
    // knows how the report read when S1 was shown it, two turns ago.
    expect(r.messages.some((m) => m.id === report)).toBe(true);
    r.reports.set("request-1", "[Teammate result withheld or no longer retained]");
    r.say("Export it.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe([
      NOTE,
      "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)",
      "[Teammate result withheld or no longer retained]",
      "Omkar: Export it.",
    ].join("\n"));
  });

  it("keeps a member's last reading past the idle life: a start that went on in a process kept warm has a reading to fall from", () => {
    // Prompt-cache keep-warm (server/cache-keepwarm.ts) holds a member's
    // Claude process for hours. The room still starts after ten quiet
    // minutes, and the kept process takes that start, so it runs in the same
    // session. A compaction on it with the hook lost is seen only if the
    // reading kept for that session outlived the ten minutes.
    const { r, elsewhere } = ready();
    // turn 2: a delta on S1, settles at T0
    r.finish(r.dispatch("editor", reading(60_000)), "S1", { reply: "Trimmed." });
    const T0 = r.state.now;
    // T0 + 15 min: a turn elsewhere prunes. T0 + 20 min: turn 3 is a start
    // by time, whole window and no cursor; the reading after turn 2 is 120k.
    r.state.now = T0 + 15 * MIN;
    elsewhere();
    r.state.now = T0 + 20 * MIN;
    r.say("Tighten the outro.");
    const start = r.dispatch("editor", reading(120_000));
    expect(start.result).toStrictEqual({ mode: "start", text: r.full(start), send: {} });
    // The kept process takes it: S1 again. S1 compacts while it runs, and
    // neither hook arrives; the turn completes ok at T0 + 22.
    r.finish(start, "S1", { reply: "Tightened.", during: () => { r.state.now = T0 + 22 * MIN; } });
    // T0 + 23 min: the reading fell from 120k to 25k in S1. A start, not a
    // resume of a session that holds the CLI's summary.
    r.state.now = T0 + 23 * MIN;
    r.say("Export it. CHARLIE");
    const next = r.dispatch("editor", reading(25_000));
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
    expect(next.result.text).toContain("Omkar: Cut the intro. ALPHA");
    // and from there the deltas go on, with the reading growing again
    r.finish(next, "S1", { reply: "Exported." });
    r.say("Thanks.");
    expect(r.dispatch("editor", reading(40_000)).result.send.resumeCursor).toBe("S1");
  });

  it("prunes while a turn never seen to end is still in place, and lands it afterwards", () => {
    // A member's record, place as last speaker and last reading are guarded
    // against pruning while its turn is in flight, so pruning is judged with
    // the flight in place; the flight is landed only afterwards. The reading
    // is what tells the two orders apart: its life is counted from the
    // member's last seen settle, while the flight is given up a day after its
    // dispatch, which came later (here, after the reading's extra two idle
    // lives: a start by time that the kept process ran in S1 again).
    const { r } = ready();
    r.finish(r.dispatch("editor", reading(60_000)), "S1", { reply: "Trimmed." });
    const T0 = r.state.now;
    r.state.now = T0 + 2 * IDLE_MS + 5 * MIN;
    r.say("Tighten the outro, slowly.");
    const lost = r.dispatch("editor", reading(90_000));
    expect(lost.result).toStrictEqual({ mode: "start", text: r.full(lost), send: {} });
    r.bind(lost);
    r.emit(lost, { type: "session.started", sessionId: "S1" });
    r.emit(lost, r.output);
    // Its completion never reaches the fold. Once the reading's life since
    // the editor's last seen settle is past, but not yet a day after the lost
    // turn's dispatch, the editor is dispatched again, which lands the lost
    // turn: a start.
    r.state.now = T0 + READING_LIFE + 30_000;
    r.say("Still there?");
    const next = r.dispatch("editor", reading(120_000));
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
    // The reading survived that dispatch: it was pruned with the flight still
    // guarding it. Landed first, it would have gone.
    expect(r.sessions.tracked()).toMatchObject({ flights: 1, readings: 1 });
    // So a compaction on the start, which the kept process runs in S1 again,
    // is still seen as a fall.
    r.finish(next, "S1", { reply: "Here." });
    r.say("And now?");
    const after = r.dispatch("editor", reading(25_000));
    expect(after.result).toStrictEqual({ mode: "start", text: r.full(after), send: {} });
  });

  it("keeps a reading past keep-warm's longest window plus the idle time a hold's end re-arms", () => {
    // Keep-warm may hold a process for its maximum window, and when the hold
    // ends the driver arms its idle timer for a full idle time, so a process
    // can take a start that long after the member's last turn. The reading
    // kept for its session must still be there to show a compaction on it.
    const { r } = ready();
    r.finish(r.dispatch("editor", reading(60_000)), "S1", { reply: "Trimmed." });
    const T0 = r.state.now;
    r.state.now = T0 + MAX_WINDOW_MINUTES * MIN + IDLE_MS + MIN;
    r.say("Tighten the outro.");
    const start = r.dispatch("editor", reading(120_000));
    expect(start.result).toStrictEqual({ mode: "start", text: r.full(start), send: {} });
    // the held process takes it: S1 again, which compacts unseen
    r.finish(start, "S1", { reply: "Tightened." });
    r.say("Export it.");
    const next = r.dispatch("editor", reading(25_000));
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("keeps a reading longer than a record when the idle life is set above a day", () => {
    // OMB_CLAUDE_SESSION_IDLE_MS may be anything up to 2^31-1 ms, and a
    // record lives that long; a reading must not go before it.
    vi.stubEnv("OMB_CLAUDE_SESSION_IDLE_MS", String(30 * 60 * MIN));
    try {
      expect(roomSessionIdleMs("claudeAgent")).toBe(30 * 60 * MIN);
      const { r } = ready();
      // turn 2 is a delta in S1 with reading 120k; S1 compacts during it, no
      // hook; it settles ok at T0, and the reading after it is 25k
      const turn = r.dispatch("editor", reading(120_000));
      expect(turn.result.send.resumeCursor).toBe("S1");
      r.finish(turn, "S1", { reply: "Trimmed." });
      const T0 = r.state.now;
      // T0 + 30 h: the record is alive, and so must the reading be: a start
      r.state.now = T0 + 30 * 60 * MIN;
      r.say("Tighten the outro.");
      const next = r.dispatch("editor", reading(25_000));
      expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
    } finally { vi.unstubAllEnvs(); }
  });
});

// A seeded model of a room on one Claude instance and one other: members
// speak in any order, lines arrive and are edited between and during turns,
// turns end well, badly or not at all, the driver refuses a resume now and
// then, a warm process ends without the harness seeing it, a turn ends in
// another session than the one that accepted it, and the engine compacts a
// session mid-turn, with its hook delivered or lost. Time passes between
// turns and while a turn runs, sometimes longer than a quiet process is
// kept, and turns are dispatched in another room meanwhile (every dispatch
// prunes). The driver behaves one of two ways, chosen per seed: it closes a
// quiet process at its idle time, or, as prompt-cache keep-warm makes it
// (server/cache-keepwarm.ts), keeps it for hours, so that a start more than
// ten quiet minutes after the member's last turn goes on in the same
// session. The model keeps, per native session, every line that session was
// shown, by a tag that changes when the line's text does, and how large the
// session's context is: the reading the next turn is given.
// Whatever the interleaving: every line of the window a turn was built from,
// as it reads now, is in the text sent or already in the session that runs
// the turn (the invariant in the module header), and no accepted turn shows
// a session a line twice.
describe("room sessions: randomized rooms", () => {
  function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const sentinels = (text: string) => [...text.matchAll(/<(L\d+)>/g)].map((match) => match[1]!);
  const SEEDS = [1, 7, 42, 1337, 2024, 9001, 31337, 65537, ...Array.from({ length: 16 }, (_, n) => 1000 + n * 7919)];
  const STEPS = 400;
  /** What the seeds exercised between them, checked once at the end. */
  const seen = { deltas: 0, starts: 0, fromDisk: 0, updates: 0, lostHooks: 0, elsewhere: 0, longTurns: 0, afterLongTurn: 0, keptWarm: 0 };
  /** How many seeds ran to the end: the check at the end means nothing without them. */
  let ran = 0;

  for (const [index, seed] of SEEDS.entries()) {
    // Every other seed, the driver keeps a quiet process for three hours
    // (keep-warm's default window) instead of its idle time, and the gaps
    // between turns straddle the idle life.
    const keepWarm = index % 2 === 1;
    const KEEP_MS = keepWarm ? 180 * MIN : IDLE_MS;
    it(`seed ${seed}${keepWarm ? " (keep-warm)" : ""}: the window is always in the text or in the session, and a delta repeats nothing`, () => {
      const random = prng(seed);
      const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      const r = room();
      const other = room({ threadId: "elsewhere", shared: { messages: r.threads, sessions: r.sessions } });
      const second = engine("claude-2");
      const third = engine("claude-3");
      const instanceOf: Record<string, RoomSessionEngine> = { editor: r.claude, writer: r.claude, scout: second };
      const members = Object.keys(instanceOf);
      let line = 0;
      const append = () => {
        const tag = `<L${line++}>`;
        const kind = random();
        if (kind < 0.6) r.say(`says ${tag}`);
        else if (kind < 0.8) r.botSays(pick(members), `posts ${tag}`, { peerPost: {} });
        else r.add({ role: "bot", kind: "activity", roomRequest: { id: tag, phase: "result" } });
      };
      /** A recent line of the person's reads differently from now on: a new tag. */
      const edit = () => {
        const recent = r.messages.slice(-12).filter((m) => m.role === "user" && m.kind === "text");
        if (recent.length) pick(recent).text = `says <L${line++}> (edited)`;
      };
      /** Time passes while a turn runs, and now and then another room takes
       * a turn of its own meanwhile. Returns how long passed. */
      const meanwhile = () => {
        const passed = pick([0, 0, MIN, 2 * MIN, 3 * MIN, 4 * MIN, 11 * MIN]);
        r.state.now += passed;
        if (random() < 0.5) {
          other.say("elsewhere");
          other.run("ghost", "G", {}, { instance: third });
          seen.elsewhere += 1;
        }
        return passed;
      };
      /** what each native session has been shown */
      const held = new Map<string, Set<string>>();
      /** the driver's one warm process per thread and instance: whose, which session, and since when it is quiet */
      const warm = new Map<string, { botId: string; session: string; endedAt: number }>();
      /** instances whose warm process ended without the harness being told */
      const endedUnseen = new Set<string>();
      /** each session's context, and each member's last reading in this room with the session it measured */
      const size = new Map<string, number>();
      const reading = new Map<string, { tokens: number; session: string }>();
      /** the member whose turn just ran longer than a quiet process is kept, to see what its next turn gets */
      let longTurnBy: string | undefined;
      let sessionSerial = 0;

      for (let step = 0; step < STEPS; step++) {
        for (let n = Math.floor(random() * 4); n > 0; n--) append();
        if (random() < 0.15) edit();
        r.state.now += random() < 0.03 ? IDLE_MS + 1
          : pick(keepWarm ? [0, 30_000, 3 * MIN, 8 * MIN, 11 * MIN, 15 * MIN, 25 * MIN] : [0, 30_000, 3 * MIN, 6 * MIN, 8 * MIN, 9 * MIN]);
        // The driver closes a process that has been quiet for as long as it keeps one.
        for (const [id, slot] of warm) if (r.state.now - slot.endedAt > KEEP_MS) warm.delete(id);
        const botId = pick(members);
        const instance = instanceOf[botId]!;
        // A warm process crashes between turns; nothing tells the harness.
        if (random() < 0.05 && warm.delete(instance.instanceId)) endedUnseen.add(instance.instanceId);
        const reset = random() < 0.05;
        const turn = r.dispatch(botId, { instance, reset, context: () => (reading.has(botId) ? { tokens: reading.get(botId)!.tokens, window: 1_000_000 } : undefined) });
        expect(turn.result.mode).not.toBe("legacy");
        const windowTags = sentinels(turn.input.window.text);
        const sentTags = sentinels(turn.result.text);
        const slot = warm.get(instance.instanceId);

        // The driver, as server/drivers/claude.ts decides it.
        let session: string;
        let rebuilt = false;
        let shown = sentTags;
        const cursor = turn.result.send.resumeCursor;
        if (turn.result.send.sessionReset) {
          expect(cursor).toBeUndefined();
          session = `N${sessionSerial++}`;
        } else if (cursor !== undefined) {
          seen.deltas += 1;
          if (longTurnBy === botId) seen.afterLongTurn += 1;
          // Resume only where main would have gone on in this very process,
          // or where that process ended unseen: then the driver reopens the
          // same session from disk, and it holds what it held.
          if (slot) expect({ botId: slot.botId, session: slot.session }, `step ${step}: a resume needs the member's own warm process`).toEqual({ botId, session: cursor });
          else { expect(endedUnseen.has(instance.instanceId), `step ${step}: a resume with no process to go on in`).toBe(true); seen.fromDisk += 1; }
          if (turn.result.text.includes("changed since")) seen.updates += 1;
          if (random() < 0.1) {
            // refused before the prompt: a new session from recoveryText
            session = `N${sessionSerial++}`;
            rebuilt = true;
            shown = sentinels(turn.result.send.recoveryText!);
            expect(shown).toEqual(windowTags);
          } else {
            session = cursor;
            const before = held.get(session) ?? new Set<string>();
            for (const tag of windowTags) {
              expect(sentTags.includes(tag) || before.has(tag), `step ${step}: ${tag} is neither sent nor held by ${session}`).toBe(true);
            }
            for (const tag of sentTags) expect(before.has(tag), `step ${step}: ${tag} sent twice to ${session}`).toBe(false);
          }
        } else {
          seen.starts += 1;
          expect(sentTags).toEqual(windowTags);
          // The member's own kept process takes a start, whether it is kept
          // for the idle time or far past it: the session goes on.
          session = slot?.botId === botId ? slot.session : `N${sessionSerial++}`;
          if (slot?.botId === botId && r.state.now - slot.endedAt > IDLE_MS) seen.keptWarm += 1;
        }
        expect(new Set(sentTags).size).toBe(sentTags.length);
        longTurnBy = undefined;

        const outcome = random();
        if (outcome < 0.08) {
          // never completes: timed out, stalled or rejected at dispatch. The
          // process may be anybody's or nobody's afterwards.
          warm.delete(instance.instanceId);
          meanwhile();
          continue;
        }
        const ok = outcome >= 0.2;
        // After the provider acted, the driver relaunches into another session
        // and the turn ends there.
        const switchTo = random() < 0.05 ? `N${sessionSerial++}` : undefined;
        // The engine compacts the session while the turn runs (one with
        // enough in it to compact). Its hook says so, or never arrives. The
        // module is only promised to see a lost hook through the reading, so
        // the model loses one only where the reading can show it: the turn
        // before reported this session's size, and this turn reports its own.
        const before = size.get(session) ?? 0;
        const compacts = !switchTo && before >= 12 && random() < 0.3;
        const known = reading.get(botId);
        const hookLost = compacts && known?.session === session && known.tokens === before && random() < 0.7;
        if (hookLost) seen.lostHooks += 1;
        // the turn waits for its engine, starts, works, and ends
        let ran = meanwhile();
        r.finish(turn, session, {
          ok, rebuilt, reply: `answers <L${line++}>`,
          notes: random() < 0.4 ? [`note <L${line++}>`] : [],
          ...(switchTo ? { switchTo } : {}),
          before: () => { ran += meanwhile(); },
          during: () => {
            for (let n = Math.floor(random() * 3); n > 0; n--) append();
            if (random() < 0.1) edit();
            if (compacts && !hookLost) r.sessions.distrust(r.threadId, botId);
            ran += meanwhile();
          },
        });
        if (ran > IDLE_MS) {
          seen.longTurns += 1;
          if (ok && !compacts && !switchTo) longTurnBy = botId;
        }
        // The provider acted on the prompt either way: the session that took
        // it holds it, and the session the turn ended in holds what the
        // member said itself.
        const ended = switchTo ?? session;
        const took = held.get(session) ?? new Set<string>();
        for (const tag of shown) took.add(tag);
        held.set(session, took);
        const wrote = held.get(ended) ?? new Set<string>();
        for (const m of r.messages) if (m.turnId === turn.turnId) for (const tag of sentinels(m.text ?? "")) wrote.add(tag);
        held.set(ended, wrote);
        // A compacted session holds a summary, none of the lines as they read.
        if (compacts) held.set(ended, new Set());
        // A session's context grows with every turn it takes; compacted, it
        // is a fraction of what it was; a new session starts small.
        size.set(session, before + 5 + Math.floor(random() * 20));
        if (switchTo) size.set(ended, 3 + Math.floor(random() * 5));
        if (compacts) size.set(ended, 1 + Math.floor(random() * 3));
        // The turn's last measurement becomes the member's reading here. Now
        // and then a turn reports none and the old one stands.
        if (hookLost || random() >= 0.1) reading.set(botId, { tokens: size.get(ended)!, session: ended });
        endedUnseen.delete(instance.instanceId);
        if (ok) warm.set(instance.instanceId, { botId, session: ended, endedAt: r.state.now });
        else warm.delete(instance.instanceId);
      }
      ran += 1;
    });
  }

  it("exercised every shape between the seeds", (ctx) => {
    // The counters are what the seed tests above left behind. Filtered down
    // to this one test, or with a seed that failed, they say nothing.
    if (ran < SEEDS.length) return ctx.skip(`${ran} of ${SEEDS.length} seeds ran to the end`);
    expect(seen.deltas).toBeGreaterThan(SEEDS.length * 20);
    expect(seen.starts).toBeGreaterThan(SEEDS.length * 20);
    for (const [what, count] of Object.entries(seen)) expect(count, what).toBeGreaterThan(SEEDS.length);
  });
});
