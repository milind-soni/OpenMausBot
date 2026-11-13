import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { fakePhone, videoFrame, videoSession } from "../testing/fake-phone.ts";
import { SCRCPY_VIDEO_PACKETS } from "../testing/scrcpy-video.ts";
import { createPhoneScreenHub, type PhoneInput, type PhoneScreenHub, type PhoneViewer } from "./hub.ts";
import { control, KEYCODES } from "./scrcpy-wire.ts";

const SERIAL = "PHONE1";
const MIB = 1024 * 1024;
/** What the recording holds after its session packet: the config packet, the key frame and ten deltas. */
const RECORDED = SCRCPY_VIDEO_PACKETS.slice(1) as Array<{ kind: "config" | "key" | "delta"; data: Buffer }>;
const frame = (kind: "config" | "key" | "delta", data: Buffer) => ({ kind, data });
const sizes = (frames: Array<{ kind: string; data: Buffer }>) => frames.map(({ kind, data }) => [kind, data.length]);
const TOUCH_BYTES = 32;
const KEY_BYTES = 28;
const hex = (...messages: Buffer[]) => Buffer.concat(messages).toString("hex");
const down = (x: number, y: number, w = 720, h = 1280): PhoneInput => ({ type: "touch", action: "down", x, y, w, h });
const press = (key: keyof typeof KEYCODES): PhoneInput => ({ type: "key", key });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Watching = PhoneViewer & {
  frames: Array<{ kind: string; data: Buffer }>;
  closes: Array<[code: number, reason: string]>;
  /** What `buffered()` answers. */
  waiting: number;
  has(count: number): Promise<void>;
  closed(): Promise<void>;
};

function viewer({ onFrame }: { onFrame?: () => void } = {}) {
  const changed = new Set<() => void>();
  const when = (met: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!met()) return;
        changed.delete(check);
        resolve();
      };
      changed.add(check);
      check();
    });
  const watching: Watching = {
    frames: [],
    closes: [],
    waiting: 0,
    send(kind, data) {
      watching.frames.push({ kind, data });
      onFrame?.();
      for (const check of changed) check();
    },
    close(code, reason) {
      watching.closes.push([code, reason]);
      for (const check of changed) check();
    },
    buffered: () => watching.waiting,
    has: (count) => when(() => watching.frames.length >= count),
    closed: () => when(() => watching.closes.length > 0),
  };
  return watching;
}

describe("createPhoneScreenHub", () => {
  let phone: ReturnType<typeof fakePhone>;
  let hub: PhoneScreenHub;

  function start(options: Parameters<typeof fakePhone>[0] = {}, deps: Partial<Parameters<typeof createPhoneScreenHub>[0]> = {}) {
    phone = fakePhone(options);
    hub = createPhoneScreenHub({ adbPath: () => phone.adbPath, serverFile: async () => phone.serverFile, ...deps });
  }

  const pushes = () => phone.calls().filter((call) => call[2] === "push");
  const removals = () => phone.calls().filter((call) => call[2] === "shell" && call[3] === "rm");

  /** A phone's first viewer, once it has the recording. The phone's scrcpy goes on reading its control socket while adb is stopped. */
  async function watchedPhone(options: Parameters<typeof fakePhone>[0] = {}) {
    start({ mode: "outlives-adb", ...options });
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    return first;
  }

  /** The phone announces a video size; settles once the hub has read it, shown by the delta sent after it. */
  async function announced(first: Watching, width: number, height: number) {
    const shown = first.frames.length + 1;
    await phone.send(Buffer.concat([videoSession(width, height), videoFrame("delta", Buffer.from("delta after the size"))]));
    await first.has(shown);
  }

  afterEach(async () => {
    await hub.closeAll();
    await removeTempDir(phone.dir);
  });

  it("sends a phone's first viewer the config packet, then the key frame, then the deltas, and keeps the video size", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);

    expect(first.frames).toEqual(RECORDED);
    expect(first.closes).toEqual([]);
    expect(hub.videoSize(SERIAL)).toEqual({ width: 720, height: 1280 });
  });

  it("gives a later viewer the cached group at once, then both the live packets in order, from one scrcpy session", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);

    const second = viewer();
    hub.watch(SERIAL, second);
    expect(second.frames).toEqual(RECORDED);

    const live = [frame("delta", Buffer.from("delta 11")), frame("key", Buffer.from("key 2")), frame("delta", Buffer.from("delta 12"))];
    await phone.send(Buffer.concat(live.map(({ kind, data }) => videoFrame(kind, data))));
    await first.has(RECORDED.length + live.length);

    expect(first.frames).toEqual([...RECORDED, ...live]);
    expect(second.frames).toEqual(first.frames);
    expect(pushes()).toHaveLength(1);

    const third = viewer();
    hub.watch(SERIAL, third);
    expect(third.frames).toEqual([RECORDED[0], ...live.slice(1)]);
  });

  it("caches a group of exactly 8 MiB, drops the frames one byte over, and keeps a new viewer waiting for the next key frame", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const group = [frame("key", Buffer.alloc(MIB, 1)), ...Array.from({ length: 7 }, () => frame("delta", Buffer.alloc(MIB, 2)))];
    await phone.send(Buffer.concat(group.map(({ kind, data }) => videoFrame(kind, data))));
    await first.has(RECORDED.length + group.length);

    const atTheCap = viewer();
    hub.watch(SERIAL, atTheCap);
    expect(sizes(atTheCap.frames)).toEqual(sizes([RECORDED[0]!, ...group]));

    await phone.send(videoFrame("delta", Buffer.from([3])));
    await first.has(RECORDED.length + group.length + 1);
    const late = viewer();
    hub.watch(SERIAL, late);
    expect(late.frames).toEqual([RECORDED[0]]);

    const next = [frame("delta", Buffer.from("no key frame yet")), frame("key", Buffer.from("key 3")), frame("delta", Buffer.from("delta after key 3"))];
    await phone.send(Buffer.concat(next.map(({ kind, data }) => videoFrame(kind, data))));
    await first.has(RECORDED.length + group.length + 1 + next.length);

    expect(first.frames.slice(-next.length)).toEqual(next);
    expect(late.frames).toEqual([RECORDED[0], ...next.slice(1)]);
    const afterTheKeyFrame = viewer();
    hub.watch(SERIAL, afterTheKeyFrame);
    expect(afterTheKeyFrame.frames).toEqual([RECORDED[0], ...next.slice(1)]);
  }, 30_000);

  it("starts a new group at a new config packet: a viewer joining then gets that packet and waits for its key frame", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const turned = frame("config", Buffer.from("config after the screen turned"));
    await phone.send(videoFrame(turned.kind, turned.data));
    await first.has(RECORDED.length + 1);

    const second = viewer();
    hub.watch(SERIAL, second);
    expect(second.frames).toEqual([turned]);

    const key = frame("key", Buffer.from("key after the screen turned"));
    await phone.send(videoFrame(key.kind, key.data));
    await first.has(RECORDED.length + 2);
    expect(second.frames).toEqual([turned, key]);
  });

  it("caches no delta that comes before a key frame: a viewer joining after a new config packet and a delta gets that packet only, then the key frame", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const turned = frame("config", Buffer.from("config after the screen turned"));
    await phone.send(Buffer.concat([videoFrame(turned.kind, turned.data), videoFrame("delta", Buffer.from("delta before the key frame"))]));
    await first.has(RECORDED.length + 2);

    const second = viewer();
    hub.watch(SERIAL, second);
    expect(second.frames).toEqual([turned]);

    const next = [frame("delta", Buffer.from("another delta before the key frame")), frame("key", Buffer.from("key after the screen turned")), frame("delta", Buffer.from("delta after the key frame"))];
    await phone.send(Buffer.concat(next.map(({ kind, data }) => videoFrame(kind, data))));
    await first.has(RECORDED.length + 2 + next.length);
    expect(second.frames).toEqual([turned, ...next.slice(1)]);
  });

  it("lifts a finger that is down when the server stops, before it stops scrcpy", async () => {
    const first = await watchedPhone();
    hub.input(SERIAL, first, down(100, 200));

    await hub.closeAll();

    expect(await phone.control(2 * TOUCH_BYTES)).toBe(hex(control.touch("down", 100, 200, 720, 1280), control.touch("up", 100, 200, 720, 1280)));
  });

  it("lifts a finger in the last column of the new video when the screen turns to portrait under an x beyond its width", async () => {
    const first = await watchedPhone();
    await announced(first, 1280, 720);
    hub.input(SERIAL, first, down(1200, 700, 1280, 720));

    await announced(first, 720, 1280);

    expect(await phone.control(2 * TOUCH_BYTES)).toBe(hex(control.touch("down", 1200, 700, 1280, 720), control.touch("up", 719, 700, 720, 1280)));
  });

  it.each([
    ["height", 720, 1000],
    ["width", 600, 1280],
  ])("lifts a finger when only the video's %s changes", async (_what, width, height) => {
    const first = await watchedPhone();
    hub.input(SERIAL, first, down(100, 200));

    await announced(first, width, height);

    expect(await phone.control(2 * TOUCH_BYTES)).toBe(hex(control.touch("down", 100, 200, 720, 1280), control.touch("up", 100, 200, width, height)));
  });

  it("leaves a finger down when the phone announces the video size it already has", async () => {
    const first = await watchedPhone();
    hub.input(SERIAL, first, down(100, 200));

    await announced(first, 720, 1280);
    hub.input(SERIAL, first, press("home"));

    expect(await phone.control(TOUCH_BYTES + KEY_BYTES)).toBe(hex(control.touch("down", 100, 200, 720, 1280), control.key(KEYCODES.home)));
  });

  it("drops input for a phone nobody watches, while the phone's screen is opening, before the phone has announced a video size, and from a viewer that left or was refused", async () => {
    const unannounced = Buffer.concat([Buffer.from("\0h264"), ...RECORDED.map(({ kind, data }) => videoFrame(kind, data))]);
    start({ mode: "outlives-adb", video: unannounced });
    const first = viewer();
    hub.input(SERIAL, first, press("home"));
    hub.watch(SERIAL, first);
    hub.input(SERIAL, first, press("home"));
    hub.input(SERIAL, first, down(100, 200));
    await first.has(RECORDED.length);
    expect(hub.videoSize(SERIAL)).toBeUndefined();
    hub.input(SERIAL, first, press("home"));
    hub.input(SERIAL, first, down(100, 200));

    await announced(first, 720, 1280);
    const left = viewer();
    hub.watch(SERIAL, left)();
    for (const other of [viewer(), viewer(), viewer()]) hub.watch(SERIAL, other);
    const fifth = viewer();
    hub.watch(SERIAL, fifth);
    expect(fifth.closes).toHaveLength(1);
    hub.input(SERIAL, left, press("home"));
    hub.input(SERIAL, fifth, press("home"));
    hub.input(SERIAL, first, press("back"));

    expect(await phone.control(KEY_BYTES)).toBe(hex(control.key(KEYCODES.back)));
  });

  it("lifts a finger once: after a down and an up, neither a hand-back nor the viewer leaving sends the phone another up", async () => {
    const first = await watchedPhone();
    const second = viewer();
    const leaves = hub.watch(SERIAL, second);
    hub.input(SERIAL, second, down(100, 200));
    hub.input(SERIAL, second, { type: "touch", action: "up", x: 110, y: 210, w: 720, h: 1280 });

    hub.liftAll();
    leaves();
    hub.input(SERIAL, first, press("home"));

    expect(await phone.control(2 * TOUCH_BYTES + KEY_BYTES)).toBe(
      hex(control.touch("down", 100, 200, 720, 1280), control.touch("up", 110, 210, 720, 1280), control.key(KEYCODES.home)),
    );
  });

  it("closes a lone viewer that fell behind once, and stops scrcpy on the phone", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    first.waiting = MIB + 1;

    await phone.send(Buffer.concat([videoFrame("delta", Buffer.from("delta 11")), videoFrame("delta", Buffer.from("delta 12"))]));
    await first.closed();

    await vi.waitFor(() => expect(removals()).toHaveLength(1));
    expect(isRunning(phone.serverPid())).toBe(false);
    expect(first.closes).toEqual([[1012, "This view fell behind the phone's screen."]]);
  });

  it("runs no adb command for a viewer that came and left while the previous session was still cleaning up", async () => {
    start();
    const first = viewer();
    const leaves = hub.watch(SERIAL, first);
    await first.has(RECORDED.length);

    leaves();
    hub.watch(SERIAL, viewer())();
    await hub.closeAll();

    expect(pushes()).toHaveLength(1);
    expect(phone.calls().at(-1)).toEqual(removals()[0]);
  });

  it("closeAll settles only once a session that had waited for the previous one's cleanup has stopped too", async () => {
    start();
    const first = viewer();
    const leaves = hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    leaves();
    const second = viewer();
    hub.watch(SERIAL, second);
    await second.has(RECORDED.length);

    await hub.closeAll();

    expect(removals()).toHaveLength(2);
    expect(isRunning(phone.serverPid())).toBe(false);
  });

  it("refuses a phone's fifth viewer with 1013 and goes on showing the four", async () => {
    start();
    const four = [viewer(), viewer(), viewer(), viewer()];
    for (const watching of four) hub.watch(SERIAL, watching);
    await four[0]!.has(RECORDED.length);

    const fifth = viewer();
    hub.watch(SERIAL, fifth);
    expect(fifth.closes).toEqual([[1013, "Too many views of this phone are open. Close another one first."]]);

    await phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await four[0]!.has(RECORDED.length + 1);
    for (const watching of four) expect(watching.frames).toHaveLength(RECORDED.length + 1);
    expect(four.flatMap((watching) => watching.closes)).toEqual([]);
    expect(fifth.frames).toEqual([]);
  });

  it("closes a viewer with more than 1 MiB unsent with 1012, and goes on showing the others", async () => {
    start();
    const first = viewer();
    const full = viewer();
    const behind = viewer();
    for (const watching of [first, full, behind]) hub.watch(SERIAL, watching);
    await first.has(RECORDED.length);
    full.waiting = MIB;
    behind.waiting = MIB + 1;

    await phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await first.has(RECORDED.length + 1);
    expect(behind.closes).toEqual([[1012, "This view fell behind the phone's screen."]]);
    expect(behind.frames).toHaveLength(RECORDED.length);
    expect(full.frames).toHaveLength(RECORDED.length + 1);

    await phone.send(videoFrame("delta", Buffer.from("delta 12")));
    await first.has(RECORDED.length + 2);
    expect(full.frames).toHaveLength(RECORDED.length + 2);
    expect(behind.frames).toHaveLength(RECORDED.length);
    expect([...first.closes, ...full.closes]).toEqual([]);
  });

  it("lets a viewer that joined catch up with up to 9 MiB unsent, and holds it to 1 MiB once it has been under that", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const joined = viewer();
    const tooFarBehind = viewer();
    hub.watch(SERIAL, joined);
    hub.watch(SERIAL, tooFarBehind);
    const live = async (count: number) => {
      await phone.send(videoFrame("delta", Buffer.from(`delta ${10 + count}`)));
      await first.has(RECORDED.length + count);
    };

    joined.waiting = 9 * MIB;
    tooFarBehind.waiting = 9 * MIB + 1;
    await live(1);
    expect(tooFarBehind.closes).toEqual([[1012, "This view fell behind the phone's screen."]]);
    joined.waiting = MIB;
    await live(2);
    joined.waiting = MIB + 1;
    await live(3);
    expect(joined.closes).toEqual([]);
    expect(joined.frames).toHaveLength(RECORDED.length + 3);

    joined.waiting = MIB - 1;
    await live(4);
    joined.waiting = MIB + 1;
    await live(5);
    expect(joined.closes).toEqual([[1012, "This view fell behind the phone's screen."]]);
    expect(joined.frames).toHaveLength(RECORDED.length + 4);
    expect(first.closes).toEqual([]);
  });

  it("stops scrcpy on the phone when its last viewer leaves, not before", async () => {
    start();
    const first = viewer();
    const second = viewer();
    const firstLeaves = hub.watch(SERIAL, first);
    const secondLeaves = hub.watch(SERIAL, second);
    await first.has(RECORDED.length);

    firstLeaves();
    await phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await second.has(RECORDED.length + 1);
    expect(first.frames).toHaveLength(RECORDED.length);
    expect(removals()).toEqual([]);

    secondLeaves();
    await vi.waitFor(() => expect(removals()).toHaveLength(1));
    expect(isRunning(phone.serverPid())).toBe(false);
    expect([...first.closes, ...second.closes]).toEqual([]);
  });

  it("runs no adb when the only viewer leaves while the scrcpy server file is fetched", async () => {
    let ask!: () => void;
    let arrive!: (file: string) => void;
    const asked = new Promise<void>((resolve) => {
      ask = resolve;
    });
    const fetched = new Promise<string>((resolve) => {
      arrive = resolve;
    });
    start({}, {
      serverFile: () => {
        ask();
        return fetched;
      },
    });
    const leaves = hub.watch(SERIAL, viewer());
    await asked;
    leaves();
    arrive(phone.serverFile);
    await hub.closeAll();

    expect(phone.calls()).toEqual([]);
  });

  it("stops scrcpy when the only viewer leaves while the phone's screen is still opening", async () => {
    start();
    const leaves = hub.watch(SERIAL, viewer());
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    leaves();
    await hub.closeAll();

    expect(pushes()).toHaveLength(1);
    expect(removals()).toHaveLength(1);
    expect(phone.calls().at(-1)).toEqual(removals()[0]);
  });

  it("opens a phone again only after its previous session has cleaned up", async () => {
    start();
    const first = viewer();
    const leaves = hub.watch(SERIAL, first);
    await first.has(RECORDED.length);

    leaves();
    const second = viewer();
    hub.watch(SERIAL, second);
    await second.has(RECORDED.length);

    const steps = phone.calls().map((call) => (call[2] === "shell" ? call[3] : call[2]));
    expect(steps.filter((step) => step === "push")).toHaveLength(2);
    expect(steps.indexOf("rm")).toBeGreaterThan(0);
    expect(steps.indexOf("rm")).toBeLessThan(steps.lastIndexOf("push"));
    expect(second.frames).toEqual(RECORDED);
  });

  it("closes viewers with 1011 when scrcpy stops on the phone, so that none asks for it again by itself", async () => {
    start({ mode: "hangs-up" });
    const first = viewer();
    const second = viewer();
    hub.watch(SERIAL, first);
    hub.watch(SERIAL, second);
    await first.closed();

    expect(first.frames).toEqual(RECORDED);
    expect(first.closes).toEqual([[1011, "The phone stopped sending its screen."]]);
    expect(second.closes).toEqual(first.closes);
  });

  it("closes viewers with 1012 when the phone is unplugged", async () => {
    start({ mode: "hangs-up" });
    const first = viewer({ onFrame: () => phone.become("gone") });
    hub.watch(SERIAL, first);
    await first.closed();

    expect(first.closes).toEqual([[1012, "The phone was unplugged."]]);
  });

  it("closes viewers with 1011 when the phone's video cannot be read", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const overEightMib = Buffer.alloc(12);
    overEightMib.writeUInt32BE(8 * MIB + 1, 8);
    await phone.send(overEightMib);
    await first.closed();

    expect(first.closes).toEqual([[1011, "The phone's video could not be read."]]);
  });

  it("closes the viewer that asked and one that joined meanwhile with 1011 when the screen cannot be opened, and does not try again", async () => {
    start({ mode: "exits" });
    const first = viewer();
    const second = viewer();
    hub.watch(SERIAL, first);
    hub.watch(SERIAL, second);
    await second.closed();

    const failed = [[1011, "Could not open the phone's screen. scrcpy stopped on the phone before the screen was open."]];
    expect(first.closes).toEqual(failed);
    expect(second.closes).toEqual(failed);
    expect([...first.frames, ...second.frames]).toEqual([]);
    await hub.closeAll();
    expect(pushes()).toHaveLength(1);
  });

  it.each([
    ["the scrcpy server file is not there", { serverFile: () => Promise.reject(new Error("Could not download scrcpy-server 5.0.1.")) }, "Could not download scrcpy-server 5.0.1."],
    ["adb is not installed", { adbPath: () => null }, "adb was not found on the server."],
  ])("closes the viewer with 1011 and runs no adb when %s", async (_what, deps, reason) => {
    start({}, deps);
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.closed();

    expect(first.closes).toEqual([[1011, reason]]);
    expect(phone.calls()).toEqual([]);
  });

  it("closeAll closes every viewer with 1012, stops scrcpy on every phone, and lets nothing be watched afterwards", async () => {
    start();
    const first = viewer();
    hub.watch(SERIAL, first);
    await first.has(RECORDED.length);
    const other = viewer();
    hub.watch("PHONE2", other);
    await other.has(RECORDED.length);
    const running = phone.serverPid();

    await hub.closeAll();

    const stopping = [[1012, "The server is stopping."]];
    expect(first.closes).toEqual(stopping);
    expect(other.closes).toEqual(stopping);
    expect(removals().map((call) => call[1]).sort()).toEqual([SERIAL, "PHONE2"]);
    expect(isRunning(running)).toBe(false);

    const calls = phone.calls().length;
    const late = viewer();
    hub.watch(SERIAL, late);
    expect(late.closes).toEqual(stopping);
    await hub.closeAll();
    expect(phone.calls()).toHaveLength(calls);
  });
});
