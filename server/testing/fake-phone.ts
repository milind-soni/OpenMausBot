import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCRCPY_VIDEO } from "./scrcpy-video.ts";

const FAKE_ADB = fileURLToPath(new URL("./fake-adb.mjs", import.meta.url));

/** One USB phone's line in `adb devices -l`, written from adb's layout and not recorded from a phone. */
export const usbPhoneLine = (serial: string, state = "device") =>
  state === "device" ? `${serial}\tdevice product:husky model:Pixel_8_Pro usb:1-2 transport_id:4` : `${serial}\t${state} usb:1-3 transport_id:5`;

/** One packet as scrcpy-server 5.0.1 frames it on its video socket. */
export function videoFrame(kind: "config" | "key" | "delta", data: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header[0] = kind === "config" ? 0x40 : kind === "key" ? 0x20 : 0;
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data]);
}

/** The packet scrcpy-server 5.0.1 sends when its video's size changes, as when the screen turns. */
export function videoSession(width: number, height: number): Buffer {
  const packet = Buffer.alloc(12);
  packet[0] = 0x80;
  packet.writeUInt32BE(width, 4);
  packet.writeUInt32BE(height, 8);
  return packet;
}

/** A copy of the fake adb in a folder of its own (`dir`, for the test to remove), with a prepared scrcpy server file. */
export function fakePhone({ mode = "", video = SCRCPY_VIDEO, devices = "", under = tmpdir() } = {}) {
  const dir = mkdtempSync(join(under, "omb-fake-adb-"));
  const adbPath = join(dir, "adb.mjs");
  copyFileSync(FAKE_ADB, adbPath);
  chmodSync(adbPath, 0o755);
  const serverFile = join(dir, "scrcpy-server");
  writeFileSync(serverFile, "the scrcpy server file");
  writeFileSync(join(dir, "video.bin"), video);
  writeFileSync(join(dir, "devices"), devices);
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const phone = {
    dir,
    adbPath,
    serverFile,
    become: (next: string) => writeFileSync(join(dir, "mode"), next),
    calls: () => (existsSync(join(dir, "calls.ndjson")) ? read("calls.ndjson").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []),
    serverPid: () => Number(read("server.pid")),
    /** Every byte the phone's control socket has received, in hex, once there are at least `bytes` of them. */
    control: (bytes: number) =>
      new Promise<string>((resolve) => {
        const look = () => {
          const received = existsSync(join(dir, "control.hex")) ? read("control.hex") : "";
          if (received.length < bytes * 2) return;
          changes.close();
          resolve(received);
        };
        const changes = watch(dir, look);
        look();
      }),
    /** More video on the running session's socket; settles once the phone has passed all of it on. */
    send: (bytes: Buffer) =>
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: Number(read(`remove-${read("port")}`)) });
        socket.once("error", reject);
        socket.once("close", () => resolve());
        socket.end(bytes);
      }),
  };
  phone.become(mode);
  return phone;
}
