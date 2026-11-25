import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ launches: [], onLaunch: null }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => tmpdir() } }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal(),
  spawn: (file, args, options) => {
    const proc = new EventEmitter();
    const arg = flag => args[args.indexOf(flag) + 1];
    if (args.includes("-File")) {
      // Windows: the helper talks over pipes. A copy of its script is read while it runs.
      proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      proc.stdin = Object.assign(new EventEmitter(), { written: [], write(data) { this.written.push(data); return true; } });
      proc.kill = () => { proc.killed = true; return true; };
      const script = arg("-File");
      fixture.launches.push({ proc, file, args, options, script, scriptText: readFileSync(script, "utf8") });
    } else {
      fixture.launches.push({ proc, args, output: arg("-o"), stop: arg("--stop-file"), finish: arg("--finish-file") });
    }
    fixture.onLaunch();
    return proc;
  },
}));

Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/synthetic-speech-resources" });
const { startSpeech, stopSpeech, finishSpeech, speechBusy } = await import("./speech.mjs");

const platform = process.platform;
const PAGE_GONE = ["did-navigate", "render-process-gone"];
const start = (target, options) => new Promise(resolve => {
  fixture.onLaunch = resolve;
  startSpeech(target, options);
});
const launch = async () => {
  const events = [];
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), { send: (channel, body) => events.push({ channel, body }) });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed });
  // Electron: a destroyed BrowserWindow throws "Object has been destroyed" when its webContents is read.
  Object.defineProperty(win, "webContents", { get: () => { if (destroyed) throw new TypeError("Object has been destroyed"); return contents; } });
  const close = () => { destroyed = true; win.emit("closed"); };
  await start(win);
  return { ...fixture.launches.at(-1), events, win, contents, close };
};
const pageListeners = session => PAGE_GONE.map(event => session.contents.listenerCount(event));
const emit = (session, line) => appendFileSync(session.output, `${JSON.stringify(line)}\n`);

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(() => {
  stopSpeech();
  for (const session of fixture.launches) session.proc.emit("close", 0);
  fixture.launches.length = 0;
  Object.defineProperty(process, "platform", { value: platform });
});

describe.skipIf(platform === "win32")("native speech file transport", () => {
  it("assembles utterances before delivering them and keeps partials partial for calls", async () => {
    const session = await launch();
    emit(session, { text: "最初の文章。", partial: true, utteranceFinal: true, speechStart: 0 });
    emit(session, { text: "次の文章。", partial: true });
    emit(session, { text: "", partial: false });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([
      { channel: "speech:transcript", body: expect.objectContaining({ text: "最初の文章。", partial: true }) },
      { channel: "speech:transcript", body: { text: "最初の文章。 次の文章。", partial: true } },
      { channel: "speech:transcript", body: { text: "最初の文章。 次の文章。", partial: false } },
      { channel: "speech:end", body: { code: 0, reason: "completed" } },
    ]);
    expect(existsSync(session.output)).toBe(false);
  });

  it("rejects results and close events from a stopped session", async () => {
    const session = await launch();
    stopSpeech();
    expect(existsSync(session.stop)).toBe(true);
    emit(session, { text: "停止後の認識結果", partial: false });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([]);
  });

  it("isolates a replacement session even if the older helper flushes late", async () => {
    const first = await launch();
    const second = await launch();
    emit(first, { text: "古い認識結果", partial: false });
    first.proc.emit("close", 0);
    emit(second, { text: "新しい認識結果", partial: false });
    second.proc.emit("close", 0);
    expect(first.events).toEqual([]);
    expect(second.events[0].body.text).toBe("新しい認識結果");
  });

  it("keeps push-to-talk finish separate from cancellation", async () => {
    const session = await launch();
    finishSpeech();
    expect(existsSync(session.finish)).toBe(true);
    expect(existsSync(session.stop)).toBe(false);
    emit(session, { text: "確定結果", partial: false });
    session.proc.emit("close", 0);
    expect(session.events[0].body.text).toBe("確定結果");
  });

  const sinkOf = () => {
    const heard = { lines: [], ends: [], replaced: 0 };
    return { heard, sink: { transcript: line => heard.lines.push(line), end: info => heard.ends.push(info), replaced: () => { heard.replaced += 1; } } };
  };
  const flag = (session, name) => session.args.includes(name) ? session.args[session.args.indexOf(name) + 1] : undefined;

  it("delivers a sink's session to the sink and tells the helper which keys end it", async () => {
    const { heard, sink } = sinkOf();
    await start(sink, { finishOnRelease: ["control", "option"] });
    const session = fixture.launches.at(-1);
    expect(flag(session, "--finish-on-release")).toBe("control,option");
    expect(speechBusy()).toBe(true);
    emit(session, { text: "what's on today", partial: false });
    session.proc.emit("close", 0);
    expect(heard.lines).toEqual([{ text: "what's on today", partial: false }]);
    expect(heard.ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(speechBusy()).toBe(false);
  });
  it("tells a replaced sink, and never ends it", async () => {
    const { heard, sink } = sinkOf();
    await start(sink);
    const first = fixture.launches.at(-1);
    await launch();
    expect(heard.replaced).toBe(1);
    first.proc.emit("close", 0);
    expect(heard.ends).toEqual([]);
  });
  it("a page's stop or finish never touches a session it did not start", async () => {
    const { sink } = sinkOf();
    await start(sink);
    const session = fixture.launches.at(-1);
    const page = { isDestroyed: () => false, webContents: { send: () => {} } };
    stopSpeech(page); finishSpeech(page); stopSpeech(null);
    expect(existsSync(session.stop)).toBe(false);
    expect(existsSync(session.finish)).toBe(false);
    finishSpeech(sink); expect(existsSync(session.finish)).toBe(true);
    stopSpeech(sink); expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
  });
  it("a window's stop and finish reach the session that window started", async () => {
    const session = await launch();
    finishSpeech(session.win);
    expect(existsSync(session.finish)).toBe(true);
    stopSpeech(session.win);
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
  });
  it("another window's stop and finish leave a window's session alone", async () => {
    const session = await launch();
    const other = { isDestroyed: () => false, webContents: { send: () => {} } };
    stopSpeech(other); finishSpeech(other);
    expect(existsSync(session.stop)).toBe(false);
    expect(existsSync(session.finish)).toBe(false);
    expect(speechBusy()).toBe(true);
  });
  it("a window that closes stops the session it started, and an ended session lets go of its window", async () => {
    const session = await launch();
    expect(session.win.listenerCount("closed")).toBe(1);
    expect(pageListeners(session)).toEqual([1, 1]);
    session.close();
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
    expect(() => session.proc.emit("close", 0)).not.toThrow();
    expect(session.events).toEqual([]);
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window's page that reloads or navigates away stops the session it started; a route change inside the page does not", async () => {
    const session = await launch();
    session.contents.emit("did-navigate-in-page", {}, "http://127.0.0.1:8799/#/settings");
    expect(existsSync(session.stop)).toBe(false);
    expect(speechBusy()).toBe(true);
    session.contents.emit("did-navigate", {}, "http://127.0.0.1:8799/");
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
    session.proc.emit("close", 0);
    expect(session.events).toEqual([]);
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window's page whose renderer goes away stops the session it started", async () => {
    const session = await launch();
    session.contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
    session.proc.emit("close", 0);
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window's session that ends on its own lets go of the window and its page", async () => {
    const session = await launch();
    emit(session, { text: "done", partial: false });
    session.proc.emit("close", 0);
    expect(session.events.at(-1)).toEqual({ channel: "speech:end", body: { code: 0, reason: "completed" } });
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window or page that goes away after its session was replaced leaves the new session alone", async () => {
    const first = await launch();
    const second = await launch();
    first.proc.emit("close", 0);
    for (const event of PAGE_GONE) first.contents.emit(event, {});
    first.close();
    expect(existsSync(second.stop)).toBe(false);
    expect(speechBusy()).toBe(true);
  });
  it("passes only known release modifiers", async () => {
    await start(sinkOf().sink, { finishOnRelease: ["control", "hyper", "control"] });
    expect(flag(fixture.launches.at(-1), "--finish-on-release")).toBe("control");
    await start(sinkOf().sink, { finishOnRelease: ["hyper"] });
    expect(fixture.launches.at(-1).args).not.toContain("--finish-on-release");
  });
});

describe("Windows speech helper", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  const say = (session, ...lines) => session.proc.stdout.emit("data", lines.map(line => `${JSON.stringify(line)}\r\n`).join(""));

  it("listens through Windows' own recognizer in PowerShell, with no key, and hands the page what it hears", async () => {
    const session = await launch();
    expect(path.win32.basename(session.file).toLowerCase()).toBe("powershell.exe");
    expect(session.args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-File", session.script]));
    expect(session.args.slice(-2)).toEqual(["-EndpointMs", "0"]);
    expect(session.options).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    expect(session.scriptText).toContain("System.Speech.Recognition.SpeechRecognitionEngine");
    expect(speechBusy()).toBe(true);
    say(session, { partial: true, text: "hello" });
    session.proc.stdout.emit("data", `${JSON.stringify({ partial: true, text: "hello there" }).slice(0, 9)}`);
    session.proc.stdout.emit("data", `${JSON.stringify({ partial: true, text: "hello there" }).slice(9)}\r\n`);
    say(session, { partial: false, text: "hello there" });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([
      { channel: "speech:transcript", body: { partial: true, text: "hello" } },
      { channel: "speech:transcript", body: { partial: true, text: "hello there" } },
      { channel: "speech:transcript", body: { partial: false, text: "hello there" } },
      { channel: "speech:end", body: { code: 0, reason: "completed" } },
    ]);
    expect(existsSync(session.script)).toBe(false);
    expect(speechBusy()).toBe(false);
  });

  it("asks the helper to end a call's turn after the quiet the call chose", async () => {
    await start({ transcript: () => {}, end: () => {}, replaced: () => {} }, { endpointMs: 900, finishOnRelease: ["control"] });
    const session = fixture.launches.at(-1);
    expect(session.args.slice(-2)).toEqual(["-EndpointMs", "900"]);
    expect(session.args).not.toContain("--finish-on-release");
  });

  it("finishes through the helper's input, and a stop ends the helper without a late result", async () => {
    const session = await launch();
    finishSpeech(session.win);
    expect(session.proc.stdin.written).toEqual(["finish\n"]);
    expect(session.proc.killed).toBeUndefined();
    stopSpeech(session.win);
    expect(session.proc.killed).toBe(true);
    expect(speechBusy()).toBe(false);
    say(session, { partial: false, text: "too late" });
    session.proc.emit("close", 1);
    expect(session.events).toEqual([]);
    expect(existsSync(session.script)).toBe(false);
  });

  it("passes on the helper's own reason when it cannot listen", async () => {
    const session = await launch();
    say(session, { error: "speech-language-missing" });
    session.proc.emit("close", 1);
    expect(session.events).toEqual([
      { channel: "speech:transcript", body: { error: "speech-language-missing" } },
      { channel: "speech:end", body: { code: 1, reason: "speech-language-missing" } },
    ]);
  });

  it("ends with a start failure when PowerShell cannot run", async () => {
    const session = await launch();
    session.proc.emit("error", new Error("spawn ENOENT"));
    session.proc.emit("close", -4058);
    expect(session.events).toEqual([{ channel: "speech:end", body: { code: 1, reason: "helper-start-failed" } }]);
    expect(speechBusy()).toBe(false);
  });
});

