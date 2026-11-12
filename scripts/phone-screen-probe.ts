// Checks the scrcpy client against a real USB phone. It only watches, and the phone gets no input, unless --keys is
// given: then it presses wakeup and home at the end of the watch, which turns the screen on and leaves the open app.
//
//   node --experimental-strip-types scripts/phone-screen-probe.ts --serial <serial> [--data-dir <dir>] [--keys]
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

import { resolveAdbPath } from "../server/drivers/phone-proxy.ts";
import { ensureScrcpyServer } from "../server/phone-screen/scrcpy-server-file.ts";
import { control, KEYCODES } from "../server/phone-screen/scrcpy-wire.ts";
import { openPhoneSession } from "../server/phone-screen/session.ts";

const WATCH_MS = 5_000;
const KEY_FRAME_WITHIN_MS = 3_000;
const KEY_GAP_MS = 1_000;
const START_CODE = Buffer.from("00000001", "hex");
// H.264: the low five bits of a NAL header are its type, and 7 is a sequence parameter set; the bits above vary.
const startsWithSps = (data: Buffer) => data.subarray(0, START_CODE.length).equals(START_CODE) && (data[START_CODE.length] & 0x1f) === 7;
const LEFTOVERS = "/data/local/tmp/openmausbot-scrcpy-*";
const SCRCPY_STOPS_WITHIN_MS = 5_000;
const LIST_PROCESSES = ["ps", "-A", "-o", "PID,ARGS"];
const FEWEST_PROCESS_LINES = 5;

const { values } = parseArgs({ options: { serial: { type: "string" }, "data-dir": { type: "string" }, keys: { type: "boolean" } } });
const serial = values.serial;
const adbPath = resolveAdbPath();
if (!serial || !adbPath) {
  console.error(serial ? "adb was not found. Install Android platform tools or set OMB_ADB_PATH." : "Usage: phone-screen-probe.ts --serial <serial> [--data-dir <dir>] [--keys]");
  process.exit(2);
}

const run = promisify(execFile);
const adb = async (...args: string[]) => (await run(adbPath, args, { timeout: 15_000 })).stdout;
const forwards = async () => new Set((await adb("forward", "--list")).split(/\r?\n/).filter(Boolean));
const scrcpyProcesses = async () => {
  const lines = (await adb("-s", serial, "shell", ...LIST_PROCESSES)).split(/\r?\n/).filter(Boolean);
  // A ps that knows these options lists itself (seen on Android 9); one that does not may print only a header.
  if (lines.length < FEWEST_PROCESS_LINES || !lines.some((line) => line.includes(LIST_PROCESSES.join(" ")))) throw new Error("the phone's processes could not be listed");
  return new Set(lines.filter((line) => line.includes("com.genymobile.scrcpy")));
};

const problems: string[] = [];

const sessionDirs = async () => {
  // The device shell runs this line; "checked" tells an empty listing from a phone adb could not reach.
  const listing = (await adb("-s", serial, "shell", `ls -d ${LEFTOVERS} 2>/dev/null; echo checked`)).split(/\r?\n/).filter(Boolean);
  if (listing.pop() !== "checked") problems.push("the phone could not be checked for leftover files");
  return new Set(listing);
};

const watch = async (serverFile: string) => {
  const startedAt = performance.now();
  const session = await openPhoneSession({ adbPath, serverFile }, serial);
  const openedAt = performance.now();
  const counts = { session: 0, config: 0, key: 0, delta: 0 };
  let size = "";
  let parameterSets = false;
  let firstKeyMs: number | undefined;
  session.onPacket((packet) => {
    counts[packet.kind] += 1;
    if (packet.kind === "session") size = `${packet.width}x${packet.height}`;
    else if (packet.kind === "config") parameterSets ||= startsWithSps(packet.data);
    else if (packet.kind === "key") firstKeyMs ??= performance.now() - openedAt;
  });
  const endedEarly = await Promise.race([session.closed, delay(WATCH_MS).then(() => undefined)]);
  const pressesKeys = values.keys && !endedEarly;
  if (pressesKeys) {
    session.send(control.key(KEYCODES.wakeup));
    await delay(KEY_GAP_MS);
    session.send(control.key(KEYCODES.home));
    // Closing at once would stop scrcpy before the phone has acted on the key.
    await delay(KEY_GAP_MS);
  }
  await session.close();
  const ended = await session.closed;
  if (pressesKeys && ended === "closed") console.log("keys sent: wakeup, then home one second later");

  const packets = counts.session + counts.config + counts.key + counts.delta;
  console.log(`codec ${packets ? "h264" : "unknown"}`);
  console.log(`session ${size || "none"}`);
  console.log(`opened in ${Math.round(openedAt - startedAt)} ms`);
  console.log(`first key frame ${firstKeyMs === undefined ? "none" : `${Math.round(firstKeyMs)} ms after opening`}`);
  console.log(`packets session=${counts.session} config=${counts.config} key=${counts.key} delta=${counts.delta}`);

  if (ended !== "closed") problems.push(`the session ended by itself: ${ended}`);
  if (!size) problems.push("no session packet arrived");
  if (!parameterSets) problems.push("no config packet starting with a sequence parameter set (00 00 00 01, then a NAL header of type 7) arrived");
  if (firstKeyMs === undefined || firstKeyMs > KEY_FRAME_WITHIN_MS) problems.push(`no key frame arrived within ${KEY_FRAME_WITHIN_MS / 1000} s of opening`);
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const temporaryDataDir = values["data-dir"] ? undefined : mkdtempSync(join(tmpdir(), "omb-phone-screen-probe-"));
try {
  const serverFile = await ensureScrcpyServer(values["data-dir"] ?? temporaryDataDir!);
  const forwardsBefore = await forwards();
  const scrcpyBefore = await scrcpyProcesses();
  const dirsBefore = await sessionDirs();
  await watch(serverFile).catch((error: unknown) => problems.push(reason(error)));

  for (const dir of await sessionDirs()) if (!dirsBefore.has(dir)) problems.push(`left on the phone: ${dir}`);
  for (const forward of await forwards()) if (!forwardsBefore.has(forward)) problems.push(`adb still forwards: ${forward}`);

  const stillRunning = async () => [...(await scrcpyProcesses())].some((line) => !scrcpyBefore.has(line));
  const giveUpAt = performance.now() + SCRCPY_STOPS_WITHIN_MS;
  let running = await stillRunning();
  while (running && performance.now() < giveUpAt) {
    await delay(250);
    running = await stillRunning();
  }
  if (running) problems.push("scrcpy is still running on the phone");
} catch (error) {
  problems.push(reason(error));
} finally {
  if (temporaryDataDir) rmSync(temporaryDataDir, { recursive: true, force: true });
}

for (const problem of problems) console.error(`FAILED: ${problem}`);
console.log(problems.length ? "phone screen probe failed" : "phone screen probe passed: video as expected, nothing left on the phone or in adb");
process.exitCode = problems.length ? 1 : 0;
