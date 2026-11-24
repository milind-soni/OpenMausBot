// The forced close's process side on a real kernel: a "daemon" that started two "Chrome" processes in a process group of
// their own, as agent-browser does. killChrome stops the Chrome processes and leaves the daemon; a pid whose start time no
// longer matches what was listed is left alone; statm sizes real processes. Runs in CI's Linux vitest shards.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { killChrome, statmBytes } from "./memory-ceiling.ts";

const startTime = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
};
const state = (pid: number): string | null => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!; } catch { return null; }
};
const gone = (pid: number) => { const now = state(pid); return now === null || now === "Z" || now === "X"; };

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return check();
}

describe.skipIf(process.platform !== "linux")("a forced close on a real kernel", () => {
  it("SIGKILLs the browser's Chrome processes and leaves its daemon, and never a pid that now runs something else", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const a = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });",
      "const b = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });",
      "const ended = [];",
      "for (const [name, child] of [['a', a], ['b', b]]) child.on('exit', (code, signal) => { ended.push(name + ' ' + signal); if (ended.length === 2) console.log('ended ' + ended.sort().join(', ')); });",
      "console.log('chrome ' + a.pid + ' ' + b.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    let daemon: ChildProcess | undefined, other: ChildProcess | undefined;
    try {
      daemon = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      daemon.stdout!.on("data", (chunk) => { out += String(chunk); });
      expect(await until(() => /chrome \d+ \d+/.test(out), 10_000)).toBe(true);
      const [a, b] = /chrome (\d+) (\d+)/.exec(out)!.slice(1).map(Number) as [number, number];
      // A process that has since taken a listed pid: its start time differs from the one listed.
      other = spawn("sleep", ["60"], { stdio: "ignore" });
      const started = new Map([[daemon.pid!, startTime(daemon.pid!)], [a, startTime(a)], [b, startTime(b)], [other.pid!, "1"]]);
      expect(statmBytes([daemon.pid!, a, b])).toBeGreaterThan(0);

      expect(killChrome({ session: "bot-a", pids: [daemon.pid!, a, b, other.pid!], daemon: daemon.pid!, started })).toBe(2);
      expect(await until(() => /ended a SIGKILL, b SIGKILL/.test(out), 10_000)).toBe(true);
      expect(gone(a) && gone(b)).toBe(true);
      expect(gone(daemon.pid!)).toBe(false);
      expect(gone(other.pid!)).toBe(false);
    } finally {
      daemon?.kill("SIGKILL");
      other?.kill("SIGKILL");
    }
  }, 30_000);
});
