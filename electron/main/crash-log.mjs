// Extracted from electron/main.mjs: the main-process log stream (server.log
// in the OS log dir) and the bounded, redacted desktop crash record. slog is
// the shared log sink; main.mjs keeps the crash listener wiring.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { formatDesktopCrashRecord } from "../diagnostics.mjs";

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/OpenMausBot on macOS,
// Console.app-visible; %APPDATA%\OpenMausBot\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
export const LOG_DIR = app.getPath("logs");
export const DESKTOP_CRASH_LOG = path.join(LOG_DIR, "desktop-crashes.log");
const DESKTOP_CRASH_LOG_MAX_BYTES = 512 * 1024;
let logStream = null;

export function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

// The server stream is intentionally asynchronous, but a fatal main-process
// exception may terminate Electron before such a write is flushed. Crash
// metadata gets its own tiny synchronous file. The formatter admits only a
// fixed set of fields, so renderer URLs, page titles, exception messages and
// absolute paths never land on disk or in a public bug report.
export function recordDesktopCrash(event) {
  let handle = null;
  try {
    const record = formatDesktopCrashRecord(event);
    if (!record) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(DESKTOP_CRASH_LOG);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(DESKTOP_CRASH_LOG, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      // O_EXCL makes first creation race-safe on Windows, where O_NOFOLLOW is
      // unavailable, as well as on POSIX.
      try {
        handle = fs.openSync(
          DESKTOP_CRASH_LOG,
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
      } catch {
        return;
      }
    }

    const stats = fs.fstatSync(handle);
    // A hard-linked or non-regular target is not an app-owned crash log.
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    // A renderer crash loop must not grow a persistent log without bound.
    // The diagnostics export reads only a bounded tail, so dropping older
    // crash metadata here preserves the useful part of the record.
    if (stats.size >= DESKTOP_CRASH_LOG_MAX_BYTES) fs.ftruncateSync(handle, 0);
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, `[${new Date().toISOString()}] ${record}\n`, "utf8");
  } catch {
    /* crash diagnostics must never change app lifecycle */
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}
