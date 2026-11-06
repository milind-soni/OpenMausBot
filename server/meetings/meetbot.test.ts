import { describe, expect, it, vi } from "vitest";
import { ADAPTERS, attribute, noteQuestion, runSession, teamsSafeName, type CallPage, type MeetbotConfig, type SessionParts } from "./meetbot.ts";

const config: MeetbotConfig = {
  url: "https://meet.systemli.org/room", platform: "jitsi", name: "Ada (notes)", consent: "Hi, I'm Ada (notes). Ask me with @notes.",
  stt: { kind: "eleven", token: "sutkn_x" }, maxMs: 60_000, lobbyMs: 30_000, aloneMs: 10_000,
};

/** A call page that is in the meeting from the start, with scripted chat lines and a chat that can refuse. */
function fakePage(options: { chatWorks?: boolean; chat?: Array<Array<{ key: string; from: string; text: string }>>; probes?: Array<Record<string, unknown>> } = {}) {
  const sent: string[] = [];
  const chats = [...(options.chat ?? [])];
  const probes = [...(options.probes ?? [])];
  const inMeeting = { inMeeting: true, lobby: false, denied: false, removed: false, ended: false, blocked: false, others: 2, names: ["Alice", "Bob"] };
  const page = {
    probe: vi.fn(async () => ({ ...inMeeting, ...probes.shift() })),
    goto: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    click: vi.fn(async () => true),
    type: vi.fn(async (_spec: unknown, text: string) => {
      if (options.chatWorks === false) return false;
      sent.push(text);
      return true;
    }),
    enter: vi.fn(async () => {}),
    op: vi.fn(async (a: { op: string }) => (a.op === "chat" ? chats.shift() ?? [] : a.op === "value" ? "" : true)),
  };
  return { page: page as unknown as CallPage, sent };
}

function parts(page: CallPage, overrides: Partial<SessionParts> = {}) {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const order: string[] = [];
  let clock = 0;
  const commands: Array<{ kind: string; [key: string]: unknown }> = [];
  const session: SessionParts = {
    config, page, adapter: { ...ADAPTERS.jitsi, prejoin: async () => {} },
    emit: (type, data) => { events.push({ type, data }); order.push(type); },
    startCapture: async () => { order.push("capture"); return { stop: async () => { order.push("capture-stopped"); } }; },
    nextCommand: () => commands.shift() ?? null,
    now: () => clock,
    pause: async (ms) => { clock += ms; },
    ...overrides,
  };
  return { session, events, order, commands, tick: (ms: number) => { clock += ms; } };
}

describe("the meeting bot's session", () => {
  it("posts the consent line before it captures anything", async () => {
    const { page, sent } = fakePage({ probes: [{}, {}, { inMeeting: false }, { inMeeting: false }] });
    const run = parts(page);
    expect(await runSession(run.session)).toBe("meeting_ended");
    expect(sent[0]).toBe(config.consent);
    expect(run.order.indexOf("consent")).toBeGreaterThan(-1);
    expect(run.order.indexOf("consent")).toBeLessThan(run.order.indexOf("capture"));
    expect(run.order.at(-1)).toBe("capture-stopped");
  });

  it("leaves without capturing when the consent line cannot be posted", async () => {
    const { page } = fakePage({ chatWorks: false });
    const run = parts(page);
    expect(await runSession(run.session)).toBe("consent_failed");
    expect(run.order).not.toContain("capture");
    expect(run.order).not.toContain("consent");
  });

  it("turns @notes lines into questions, skips its own lines, and leaves on @notes stop", async () => {
    const { page, sent } = fakePage({ chat: [
      [{ key: "0", from: "Alice", text: "earlier line" }],
      [{ key: "0", from: "Alice", text: "earlier line" }, { key: "1", from: "Ada (notes)", text: "@notes from myself" }, { key: "2", from: "Bob", text: "@notes what did we decide?" }],
      [{ key: "4", from: "Ada notes (Unverified)", text: "Hi, I'm Ada (notes). Ask me with @notes. 10:02" }, { key: "5", from: "Host", text: "Hi, I'm Ada (notes). Ask me with @notes." }],
      [{ key: "3", from: "Alice", text: "@notes stop" }],
    ] });
    const run = parts(page);
    expect(await runSession(run.session)).toBe("stop_requested");
    expect(run.events.filter((e) => e.type === "question").map((e) => e.data)).toEqual([{ from: "Bob", text: "what did we decide?" }]);
    expect(sent.at(-1)).toMatch(/leaving now/i);
  });

  it("never leaves as alone when the page shows no participant count", async () => {
    const counted = parts(fakePage({ probes: [{}, ...Array.from({ length: 30 }, () => ({ others: null, names: [] }))] }).page);
    expect(await runSession(counted.session)).toBe("max_length");
    const empty = parts(fakePage({ probes: [{}, ...Array.from({ length: 30 }, () => ({ others: 0, names: [] }))] }).page);
    expect(await runSession(empty.session)).toBe("alone");
  });

  it("waits in the lobby and reports a refusal or the lobby limit", async () => {
    const denied = parts(fakePage({ probes: [{ inMeeting: false, lobby: true }, { inMeeting: false, denied: true }] }).page);
    expect(await runSession(denied.session)).toBe("denied");
    expect(denied.order).toEqual(["phase", "phase"]);
    const nobody = parts(fakePage({ probes: Array.from({ length: 100 }, () => ({ inMeeting: false, lobby: true })) }).page);
    expect(await runSession(nobody.session)).toBe("lobby_timeout");
    expect(nobody.order).not.toContain("capture");
  });

  it("hands chat commands to the meeting and reports each one", async () => {
    const { page, sent } = fakePage({ probes: [{}, {}, {}, { inMeeting: false }, { inMeeting: false }] });
    const run = parts(page);
    run.commands.push({ kind: "chat", id: "c1", text: "We decided to launch on the 20th." });
    await runSession(run.session);
    expect(sent).toContain("We decided to launch on the 20th.");
    expect(run.events.find((e) => e.type === "sent")?.data).toEqual({ id: "c1", ok: true });
  });
});

describe("meeting bot helpers", () => {
  it("reads @notes questions wherever the platform puts them", () => {
    expect(noteQuestion("@notes what have we decided?")).toEqual({ stop: false, question: "what have we decided?" });
    expect(noteQuestion("Alice says:@notes summary please")).toEqual({ stop: false, question: "summary please" });
    expect(noteQuestion("@notes stop")).toEqual({ stop: true, question: "" });
    expect(noteQuestion("email me@notes.com")).toBeNull();
    expect(noteQuestion("no question here")).toBeNull();
  });

  it("gives each word to whoever was shown speaking, minus the page's lag", () => {
    const timeline = [{ at: 1_000, name: "Alice" }, { at: 4_200, name: "Bob" }];
    const lines = attribute([{ w: "Hello", s: 0, e: 500 }, { w: "there.", s: 600, e: 1_000 }, { w: "Hi", s: 3_000, e: 3_400 }, { w: "Alice.", s: 3_500, e: 3_900 }], timeline, 1_200);
    expect(lines.map((line) => [line.speaker, line.text])).toEqual([["Alice", "Hello there."], ["Bob", "Hi Alice."]]);
  });

  it("keeps a Teams guest name to the characters Teams accepts", () => {
    expect(teamsSafeName("Ada (notes)")).toBe("Ada notes");
    expect(teamsSafeName("((()))")).toBe("Notes");
  });
});
