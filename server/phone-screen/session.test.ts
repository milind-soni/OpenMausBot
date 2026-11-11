import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { SCRCPY_VIDEO, SCRCPY_VIDEO_PACKETS } from "../testing/scrcpy-video.ts";
import { serverArgs, type VideoPacket } from "./scrcpy-wire.ts";
import { openPhoneSession, type PhoneSession } from "./session.ts";

const FAKE_ADB = fileURLToPath(new URL("../testing/fake-adb.mjs", import.meta.url));
const SERIAL = "PHONE1";
const deviceDir = (scid: string | undefined) => `/data/local/tmp/openmausbot-scrcpy-${scid}`;
const deviceJar = (scid: string | undefined) => `${deviceDir(scid)}/scrcpy-server.jar`;
const removal = (scid: string | undefined) => ["-s", SERIAL, "shell", "rm", "-rf", deviceDir(scid)];

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const refusesConnections = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });

describe("openPhoneSession", () => {
  let dir = "";
  let session: PhoneSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await removeTempDir(dir);
  });

  function fakePhone(mode = "", video = SCRCPY_VIDEO) {
    dir = mkdtempSync(join(tmpdir(), "omb-fake-adb-"));
    const adbPath = join(dir, "adb.mjs");
    copyFileSync(FAKE_ADB, adbPath);
    chmodSync(adbPath, 0o755);
    const serverFile = join(dir, "scrcpy-server");
    writeFileSync(serverFile, "the scrcpy server file");
    writeFileSync(join(dir, "video.bin"), video);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    const phone = {
      deps: { adbPath, serverFile },
      become: (next: string) => writeFileSync(join(dir, "mode"), next),
      calls: () => read("calls.ndjson").trim().split("\n").map((line) => JSON.parse(line) as string[]),
      /** The scid of each session started on this phone, read from where it pushed its file. */
      scids: () => phone.calls().filter((call) => call[2] === "push").map((push) => /-([0-9a-f]{8})\/[^/]*$/.exec(push[4] ?? "")?.[1]),
      port: () => Number(read("port")),
      /** What the phone's control socket has received, in hex. */
      controlBytes: () => (existsSync(join(dir, "control.hex")) ? read("control.hex") : ""),
      /** The same, once it is at least `bytes` long. */
      controlBytesOnce: (bytes: number) =>
        new Promise<string>((resolve) => {
          const look = () => {
            const received = phone.controlBytes();
            if (received.length < bytes * 2) return;
            changes.close();
            resolve(received);
          };
          const changes = watch(dir, look);
          look();
        }),
      serverPid: () => Number(read("server.pid")),
    };
    phone.become(mode);
    return phone;
  }

  const packetsOf = (opened: PhoneSession, count: number) =>
    new Promise<VideoPacket[]>((resolve) => {
      const packets: VideoPacket[] = [];
      opened.onPacket((packet) => {
        packets.push(packet);
        if (packets.length === count) resolve(packets);
      });
    });

  it("starts scrcpy through adb, hands out the phone's video in order, and leaves nothing behind when closed", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);

    const seenBeforeLeaving: VideoPacket[] = [];
    const leave = session.onPacket((packet) => {
      seenBeforeLeaving.push(packet);
      leave();
    });
    await expect(packetsOf(session, SCRCPY_VIDEO_PACKETS.length)).resolves.toEqual(SCRCPY_VIDEO_PACKETS);
    expect(seenBeforeLeaving).toEqual(SCRCPY_VIDEO_PACKETS.slice(0, 1));

    const started = phone.calls();
    const [scid = ""] = phone.scids();
    expect(started).toEqual([
      ["-s", SERIAL, "push", phone.deps.serverFile, deviceJar(scid)],
      ["-s", SERIAL, "forward", "tcp:0", `localabstract:scrcpy_${scid}`],
      ["-s", SERIAL, "shell", `CLASSPATH=${deviceJar(scid)}`, "app_process", "/", "com.genymobile.scrcpy.Server", ...serverArgs(Number.parseInt(scid, 16))],
      ["-s", SERIAL, "forward", "--remove", `tcp:${phone.port()}`],
    ]);
    expect(isRunning(phone.serverPid())).toBe(true);

    await session.close();

    expect(phone.calls().slice(started.length)).toEqual([removal(scid)]);
    expect(isRunning(phone.serverPid())).toBe(false);
    await expect(session.closed).resolves.toBe("closed");
  });

  it("delivers exactly what is sent to the phone's control socket, in order", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);
    const messages = ["0200fffe", "00", "09000000e4bda0"];

    for (const message of messages) session.send(Buffer.from(message, "hex"));

    await expect(phone.controlBytesOnce(12)).resolves.toBe(messages.join(""));
  });

  it("writes nothing that is sent after close(), though the phone's scrcpy still reads", async () => {
    const phone = fakePhone("outlives-adb");
    session = await openPhoneSession(phone.deps, SERIAL);
    session.send(Buffer.from("0201", "hex"));
    await phone.controlBytesOnce(2);

    const closing = session.close();
    session.send(Buffer.from("0304", "hex"));
    await closing;
    session.send(Buffer.from("0506", "hex"));

    expect(phone.controlBytes()).toBe("0201");
  });

  it("closes the control connection on close(), which stops a scrcpy that stopping adb leaves running", async () => {
    const phone = fakePhone("outlives-adb");
    session = await openPhoneSession(phone.deps, SERIAL);

    await session.close();

    expect(existsSync(join(dir, "control.closed"))).toBe(true);
  });

  it("says the server stopped, and raises no uncaught error, when the phone resets the control connection", async () => {
    const uncaught: unknown[] = [];
    const note = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", note);
    try {
      const phone = fakePhone("resets-control");
      session = await openPhoneSession(phone.deps, SERIAL);

      await expect(session.closed).resolves.toBe("server-exit");
      expect(uncaught).toEqual([]);
      expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
    } finally {
      process.off("uncaughtException", note);
    }
  });

  it("says the server stopped when the phone closes the control connection, whatever it sent there, and ends the adb child", async () => {
    const phone = fakePhone("drops-control");
    session = await openPhoneSession(phone.deps, SERIAL);

    await expect(session.closed).resolves.toBe("server-exit");
    expect(isRunning(phone.serverPid())).toBe(false);
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
  });

  it("keeps two sessions on one phone apart: closing one removes only its own directory", async () => {
    const phone = fakePhone();
    const first = await openPhoneSession(phone.deps, SERIAL);
    try {
      session = await openPhoneSession(phone.deps, SERIAL);
      const started = phone.calls();
      const [firstScid, secondScid] = phone.scids();
      expect(secondScid).not.toBe(firstScid);
      expect(started.filter((call) => call[2] === "push").map((push) => push[4])).toEqual([deviceJar(firstScid), deviceJar(secondScid)]);
      expect(started.filter((call) => call[3] === "tcp:0").map((forward) => forward[4])).toEqual([`localabstract:scrcpy_${firstScid}`, `localabstract:scrcpy_${secondScid}`]);

      await first.close();

      expect(phone.calls().slice(started.length)).toEqual([removal(firstScid)]);
    } finally {
      await first.close();
    }
  });

  it("settles closed only after the cleanup when close() ends the session", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);

    void session.close();

    await expect(session.closed).resolves.toBe("closed");
    expect(isRunning(phone.serverPid())).toBe(false);
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
  });

  it("says closed when close() ends the session, even if the phone is gone by then", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);

    phone.become("gone");
    await session.close();

    await expect(session.closed).resolves.toBe("closed");
  });

  it.each([
    ["throws", () => {
      throw new Error("a listener failed");
    }],
    ["closes the session", (opened: PhoneSession) => void opened.close()],
  ])("ends the session as closed when a listener %s on its first packet, and hands out nothing more", async (_what, leave) => {
    const phone = fakePhone();
    const opened = await openPhoneSession(phone.deps, SERIAL);
    session = opened;
    const seenBefore: VideoPacket[] = [];
    const seenAfter: VideoPacket[] = [];
    let left = 0;
    opened.onPacket((packet) => seenBefore.push(packet));
    opened.onPacket(() => {
      left += 1;
      leave(opened);
    });
    opened.onPacket((packet) => seenAfter.push(packet));

    await expect(opened.closed).resolves.toBe("closed");
    expect(left).toBe(1);
    expect(seenBefore).toEqual(SCRCPY_VIDEO_PACKETS.slice(0, 1));
    expect(seenAfter).toEqual([]);
    expect(isRunning(phone.serverPid())).toBe(false);
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
  });

  it("says the server stopped when it exits by itself, and still removes its files", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);

    process.kill(phone.serverPid());

    await expect(session.closed).resolves.toBe("server-exit");
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
  });

  it("says the server stopped when the phone closes the video stream, and ends the adb child", async () => {
    const phone = fakePhone("hangs-up");
    session = await openPhoneSession(phone.deps, SERIAL);

    await expect(packetsOf(session, SCRCPY_VIDEO_PACKETS.length)).resolves.toEqual(SCRCPY_VIDEO_PACKETS);
    await expect(session.closed).resolves.toBe("server-exit");
    expect(isRunning(phone.serverPid())).toBe(false);
  });

  it("says the phone is gone when adb no longer finds it", async () => {
    const phone = fakePhone();
    session = await openPhoneSession(phone.deps, SERIAL);

    phone.become("gone");
    process.kill(phone.serverPid());

    await expect(session.closed).resolves.toBe("device-gone");
  });

  it.each(["adb: device 'PHONE1' not found", "error: device offline", "adb: no devices/emulators found"])(
    "says the phone is gone when only the stopped server's stderr says %s",
    async (words) => {
      const phone = fakePhone(`stderr:${words}`);
      session = await openPhoneSession(phone.deps, SERIAL);

      process.kill(phone.serverPid());

      await expect(session.closed).resolves.toBe("device-gone");
      expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
    },
  );

  it("ends with a protocol error when the phone sends something other than scrcpy 5.0.1 H.264 video", async () => {
    const phone = fakePhone("", Buffer.concat([Buffer.from("0068323635", "hex"), SCRCPY_VIDEO.subarray(5)]));
    session = await openPhoneSession(phone.deps, SERIAL);
    const seen: VideoPacket[] = [];
    session.onPacket((packet) => seen.push(packet));

    await expect(session.closed).resolves.toBe("protocol");
    expect(seen).toEqual([]);
    expect(isRunning(phone.serverPid())).toBe(false);
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
  });

  const step = ([, , command, first]: string[]) =>
    command === "shell" ? (first === "rm" ? "remove files" : "start server") : command === "forward" ? (first === "tcp:0" ? "forward" : "remove forward") : command;

  it.each([
    ["adb does not find the phone", "gone", "adb: device 'PHONE1' not found", ["push", "remove files"]],
    ["adb names no forwarded port", "no-port", "adb did not name the port it forwarded.", ["push", "forward", "remove files"]],
    ["the server exits at once", "exits", "scrcpy stopped on the phone before the screen was open.", ["push", "forward", "remove forward", "remove files"]],
    ["the phone never sends a byte", "silent", "The phone sent no video within 0.3 seconds.", ["push", "forward", "remove forward", "remove files"]],
  ])("fails to open when %s, and leaves nothing behind", async (_what, mode, reason, steps) => {
    const phone = fakePhone(mode);

    await expect(openPhoneSession({ ...phone.deps, startTimeoutMs: 300 }, SERIAL)).rejects.toThrow(`Could not open the phone's screen. ${reason}`);

    // The time limit can end a server that had not yet logged its start.
    const calls = phone.calls().filter((call) => step(call) !== "start server");
    expect(calls.map(step)).toEqual(steps);
    expect(calls.at(-1)).toEqual(removal(phone.scids()[0]));
    if (steps.includes("remove forward")) {
      expect(calls.at(-2)).toEqual(["-s", SERIAL, "forward", "--remove", `tcp:${phone.port()}`]);
      await expect(refusesConnections(phone.port())).resolves.toBe(true);
    }
  });

  it("fails to open when the control connection is refused, and leaves nothing behind", async () => {
    const phone = fakePhone("no-control");

    await expect(openPhoneSession(phone.deps, SERIAL)).rejects.toThrow("Could not open the phone's screen. The control connection to the phone could not be opened.");

    expect(phone.calls().map(step)).toEqual(["push", "forward", "start server", "remove forward", "remove files"]);
    expect(phone.calls().at(-1)).toEqual(removal(phone.scids()[0]));
    expect(isRunning(phone.serverPid())).toBe(false);
    await expect(refusesConnections(phone.port())).resolves.toBe(true);
  });

  it("fails to open when adb cannot be started for the server", async () => {
    const phone = fakePhone("vanishes");

    await expect(openPhoneSession(phone.deps, SERIAL)).rejects.toThrow(`Could not open the phone's screen. spawn ${phone.deps.adbPath} ENOENT`);

    expect(phone.calls().map(step)).toEqual(["push", "forward"]);
  });
});
