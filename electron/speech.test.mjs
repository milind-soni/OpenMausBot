import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ launches: [], windows: [] }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => tmpdir() } }));
vi.mock("node:child_process", () => ({
  spawn: (_file, args) => {
    const proc = new EventEmitter();
    const arg = flag => args[args.indexOf(flag) + 1];
    fixture.launches.push({ proc, args, output: arg("-o"), stop: arg("--stop-file"), finish: arg("--finish-file") });
    return proc;
  },
}));

Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/synthetic-speech-resources" });
const { startSpeech, stopSpeech, finishSpeech, speechBusy } = await import("./speech.mjs");

const PAGE_GONE = ["did-navigate", "render-process-gone"];
const launch = () => {
  const events = [];
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), { send: (channel, body) => events.push({ channel, body }) });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed });
  // Electron: a destroyed BrowserWindow throws "Object has been destroyed" when its webContents is read.
  Object.defineProperty(win, "webContents", { get: () => { if (destroyed) throw new TypeError("Object has been destroyed"); return contents; } });
  const close = () => { destroyed = true; win.emit("closed"); };
  startSpeech(win);
  return { ...fixture.launches.at(-1), events, win, contents, close };
};
const pageListeners = session => PAGE_GONE.map(event => session.contents.listenerCount(event));
const emit = (session, line) => appendFileSync(session.output, `${JSON.stringify(line)}\n`);

afterEach(() => {
  stopSpeech();
  for (const session of fixture.launches) session.proc.emit("close", 0);
  fixture.launches.length = 0;
});

describe.skipIf(process.platform !== "darwin")("native speech file transport", () => {
  it("assembles utterances before delivering them and keeps partials partial for calls", async () => {
    const session = launch();
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

  it("rejects results and close events from a stopped session", () => {
    const session = launch();
    stopSpeech();
    expect(existsSync(session.stop)).toBe(true);
    emit(session, { text: "停止後の認識結果", partial: false });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([]);
  });

  it("isolates a replacement session even if the older helper flushes late", () => {
    const first = launch();
    const second = launch();
    emit(first, { text: "古い認識結果", partial: false });
    first.proc.emit("close", 0);
    emit(second, { text: "新しい認識結果", partial: false });
    second.proc.emit("close", 0);
    expect(first.events).toEqual([]);
    expect(second.events[0].body.text).toBe("新しい認識結果");
  });

  it("keeps push-to-talk finish separate from cancellation", () => {
    const session = launch();
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

  it("delivers a sink's session to the sink and tells the helper which keys end it", () => {
    const { heard, sink } = sinkOf();
    startSpeech(sink, { finishOnRelease: ["control", "option"] });
    const session = fixture.launches.at(-1);
    expect(flag(session, "--finish-on-release")).toBe("control,option");
    expect(speechBusy()).toBe(true);
    emit(session, { text: "what's on today", partial: false });
    session.proc.emit("close", 0);
    expect(heard.lines).toEqual([{ text: "what's on today", partial: false }]);
    expect(heard.ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(speechBusy()).toBe(false);
  });
  it("tells a replaced sink, and never ends it", () => {
    const { heard, sink } = sinkOf();
    startSpeech(sink);
    const first = fixture.launches.at(-1);
    launch();
    expect(heard.replaced).toBe(1);
    first.proc.emit("close", 0);
    expect(heard.ends).toEqual([]);
  });
  it("a page's stop or finish never touches a session it did not start", () => {
    const { sink } = sinkOf();
    startSpeech(sink);
    const session = fixture.launches.at(-1);
    const page = { isDestroyed: () => false, webContents: { send: () => {} } };
    stopSpeech(page); finishSpeech(page); stopSpeech(null);
    expect(existsSync(session.stop)).toBe(false);
    expect(existsSync(session.finish)).toBe(false);
    finishSpeech(sink); expect(existsSync(session.finish)).toBe(true);
    stopSpeech(sink); expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
  });
  it("a window's stop and finish reach the session that window started", () => {
    const session = launch();
    finishSpeech(session.win);
    expect(existsSync(session.finish)).toBe(true);
    stopSpeech(session.win);
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
  });
  it("another window's stop and finish leave a window's session alone", () => {
    const session = launch();
    const other = { isDestroyed: () => false, webContents: { send: () => {} } };
    stopSpeech(other); finishSpeech(other);
    expect(existsSync(session.stop)).toBe(false);
    expect(existsSync(session.finish)).toBe(false);
    expect(speechBusy()).toBe(true);
  });
  it("a window that closes stops the session it started, and an ended session lets go of its window", () => {
    const session = launch();
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
  it("a window's page that reloads or navigates away stops the session it started; a route change inside the page does not", () => {
    const session = launch();
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
  it("a window's page whose renderer goes away stops the session it started", () => {
    const session = launch();
    session.contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(existsSync(session.stop)).toBe(true);
    expect(speechBusy()).toBe(false);
    session.proc.emit("close", 0);
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window's session that ends on its own lets go of the window and its page", () => {
    const session = launch();
    emit(session, { text: "done", partial: false });
    session.proc.emit("close", 0);
    expect(session.events.at(-1)).toEqual({ channel: "speech:end", body: { code: 0, reason: "completed" } });
    expect(session.win.listenerCount("closed")).toBe(0);
    expect(pageListeners(session)).toEqual([0, 0]);
  });
  it("a window or page that goes away after its session was replaced leaves the new session alone", () => {
    const first = launch();
    const second = launch();
    first.proc.emit("close", 0);
    for (const event of PAGE_GONE) first.contents.emit(event, {});
    first.close();
    expect(existsSync(second.stop)).toBe(false);
    expect(speechBusy()).toBe(true);
  });
  it("passes only known release modifiers", () => {
    startSpeech(sinkOf().sink, { finishOnRelease: ["control", "hyper", "control"] });
    expect(flag(fixture.launches.at(-1), "--finish-on-release")).toBe("control");
    startSpeech(sinkOf().sink, { finishOnRelease: ["hyper"] });
    expect(fixture.launches.at(-1).args).not.toContain("--finish-on-release");
  });
});
