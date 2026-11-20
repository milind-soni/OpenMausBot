import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ADAPTERS, attribute, chunkStream, noteQuestion, runSession, teamsSafeName, whisperStream, type CallPage, type MeetbotConfig, type SessionParts } from "./meetbot.ts";

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

describe("the meeting bot on Google Meet", () => {
  it("stops at Meet's home page instead of typing its name into the code box, and only says lobby when waiting", async () => {
    const { page, sent } = fakePage({ probes: [{ inMeeting: false, home: true }] });
    const run = parts(page, { config: { ...config, platform: "meet", url: "https://meet.google.com/abc-defg-hij" }, adapter: ADAPTERS.meet });
    expect(await runSession(run.session)).toBe("not_found");
    expect(sent).toEqual([]);
    expect(run.events.map((e) => e.data?.phase)).toEqual(["joining"]);
  });

  it("keeps the meeting code and asks for the signed-in account", () => {
    expect(ADAPTERS.meet.url("https://meet.google.com/meet/abc-defg-hij", true)).toBe("https://meet.google.com/meet/abc-defg-hij?hl=en&authuser=0");
    expect(ADAPTERS.meet.url("https://meet.google.com/abc-defg-hij", false)).toBe("https://meet.google.com/abc-defg-hij?hl=en");
  });

  it("joins as the signed-in account without typing a guest name", async () => {
    const { page, sent } = fakePage({ probes: [{ inMeeting: false }, { inMeeting: true }, { inMeeting: false }, { inMeeting: false }] });
    const exists = page.exists as unknown as ReturnType<typeof vi.fn>;
    exists.mockImplementation(async (spec: { css?: string }) => !String(spec.css ?? "").includes("name"));
    const op = page.op as unknown as ReturnType<typeof vi.fn>;
    const base = op.getMockImplementation() as (a: { op: string }) => Promise<unknown>;
    op.mockImplementation(async (a: { op: string }) => (a.op === "account" ? "Milind" : base(a)));
    const run = parts(page, { config: { ...config, platform: "meet", url: "https://meet.google.com/abc-defg-hij", profileDir: "/p" }, adapter: ADAPTERS.meet });
    await runSession(run.session);
    expect(run.events.find((e) => e.type === "signed_in")?.data).toEqual({ as: "Milind" });
    expect(sent[0]).toBe(config.consent);
  });
});

describe("local transcription install", () => {
  function scriptedSpawn(plan: Array<number | "hang">) {
    const calls: Array<{ file: string; args: string[]; detached?: boolean }> = [];
    const killed: string[] = [];
    const groups: number[] = [];
    let n = 0;
    const spawn = ((file: string, args: readonly string[] = [], options?: { detached?: boolean }) => {
      const behavior = plan[n++] ?? "hang";
      calls.push({ file, args: [...args], detached: options?.detached });
      const listeners: Array<(code: number | null) => void> = [];
      const child = {
        pid: 424242,
        kill(signal?: string) {
          killed.push(signal ?? "SIGTERM");
          for (const listener of listeners) listener(null);
        },
        on(event: string, cb: (code: number | null) => void) {
          if (event === "exit") {
            listeners.push(cb);
            if (typeof behavior === "number") queueMicrotask(() => cb(behavior));
          }
          return child;
        },
        stdout: null,
        stdin: null,
      };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawn, calls, killed, groups };
  }

  it("leaves while the first install is still running", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-whisper-"));
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const scripted = scriptedSpawn(["hang"]);
    const stream = whisperStream((type, data) => { events.push({ type, data }); }, () => {}, () => {}, {
      home,
      stopWaitMs: 50,
      groupProcesses: true,
      killGroup(pid: number) { scripted.groups.push(pid); },
      spawn: scripted.spawn,
    });
    const result = await Promise.race([
      stream.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ]);
    rmSync(home, { recursive: true, force: true });
    expect(result).toBe("stopped");
    expect(scripted.killed).toContain("SIGKILL");
    expect(scripted.groups).toEqual([424242]);
    expect(scripted.calls[0]?.detached).toBe(true);
    expect(events.some((event) => event.type === "stt" && event.data?.status === "installing")).toBe(true);
    expect(events.some((event) => event.type === "stt" && event.data?.status === "failed")).toBe(false);
  });

  it("installs again when the virtual environment cannot import", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-whisper-"));
    mkdirSync(join(home, "venv", "bin"), { recursive: true });
    writeFileSync(join(home, "venv", "bin", "python"), "");
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const scripted = scriptedSpawn([1, "hang"]);
    const stream = whisperStream((type, data) => { events.push({ type, data }); }, () => {}, () => {}, {
      home,
      stopWaitMs: 50,
      spawn: scripted.spawn,
    });
    for (let i = 0; i < 50 && scripted.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await stream.stop();
    rmSync(home, { recursive: true, force: true });
    expect(scripted.calls[0]?.args).toEqual(["-c", "import faster_whisper, numpy"]);
    expect(scripted.calls[1]?.file).toBe("bash");
    expect(events.some((event) => event.type === "stt" && event.data?.status === "installing")).toBe(true);
    expect(events.some((event) => event.type === "stt" && event.data?.status === "failed")).toBe(false);
  });
});

describe("speech-to-text done by the server", () => {
  it("sends each utterance, cut on silence, as an audio event and attributes the words that come back", async () => {
    const events: Array<{ type: string; data?: Record<string, any> }> = [];
    const replies: Array<{ start: number; words: Array<{ w: string; s: number; e: number }> }> = [];
    const heard: Array<{ w: string; s: number }> = [];
    const stream = chunkStream((type, data) => { events.push({ type, data }); }, () => replies.splice(0), (words) => heard.push(...words), () => {},
      async (pcm) => Buffer.from(`OGG${pcm.length}`));
    const tone = (ms: number, loud: boolean) => {
      const out = Buffer.alloc(ms * 32);
      for (let i = 0; i < out.length; i += 2) out.writeInt16LE(loud ? Math.round(3_000 * Math.sin(i / 10)) : 0, i);
      return out;
    };
    stream.write(Buffer.concat([tone(600, false), tone(900, true), tone(900, false)]));
    for (let i = 0; i < 50 && !events.some((e) => e.type === "audio"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const audio = events.find((e) => e.type === "audio")!.data!;
    expect(audio).toMatchObject({ n: 1 });
    expect(Buffer.from(audio.b64, "base64").toString()).toMatch(/^OGG\d+$/);
    expect(audio.ms).toBeGreaterThanOrEqual(900);
    expect(audio.ms).toBeLessThan(1_500);
    replies.push({ start: audio.start, words: [{ w: "Hello", s: 100, e: 400 }] });
    await stream.stop();
    expect(heard).toEqual([{ w: "Hello", s: audio.start + 100, e: audio.start + 400 }]);
  });
});
