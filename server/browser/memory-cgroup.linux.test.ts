// The browsers' kernel memory limit on a real kernel, as the Cloud home's root supervisor sets it up: a "server" child,
// running as an unprivileged user in its own leaf, starts a memory-hungry "Chrome" through the generated launcher; the
// launcher moves it into the browsers' group; the kernel kills it at the group's limit; the server keeps answering.
// It needs root and a cgroup v2 tree with the memory controller: CI runs it as root in the build job
// (OMB_CGROUP_TEST=require, where it fails rather than skips); elsewhere it is skipped.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { launcherScript } from "./chrome/wrapper.ts";
import { groupOomKills, ownCgroupDir, setUpBrowserCgroup, spawnInCgroup } from "./memory-cgroup.ts";

const MB = 1_048_576;
const required = process.env.OMB_CGROUP_TEST === "require";
const root = process.platform === "linux" && process.getuid?.() === 0;
const v2 = process.platform === "linux" && existsSync("/sys/fs/cgroup/cgroup.controllers")
  && /(^|\s)memory(\s|$)/.test(readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8"));
/** nobody, as maus is on a Cloud home: the supervisor gives it the right to move its own processes, and nothing else. */
const NOBODY = { uid: 65_534, gid: 65_534 };

function answer(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", timeout: 5_000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("no answer in 5 s")));
    req.on("error", reject);
    req.end();
  });
}

function lines(child: ChildProcess): { next(pattern: RegExp, ms: number): Promise<string>; all: string[] } {
  const all: string[] = [];
  const waiting: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
  let rest = "";
  child.stdout!.on("data", (chunk) => {
    rest += String(chunk);
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, at); rest = rest.slice(at + 1);
      all.push(line);
      for (const wait of waiting.filter((one) => one.pattern.test(line))) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(line); }
    }
  });
  return {
    all,
    next: (pattern, ms) => new Promise((resolve, reject) => {
      const found = all.find((line) => pattern.test(line));
      if (found) { resolve(found); return; }
      const timer = setTimeout(() => reject(new Error(`no line like ${pattern} in ${ms} ms; saw: ${all.join(" | ")}`)), ms);
      waiting.push({ pattern, resolve: (line) => { clearTimeout(timer); resolve(line); } });
    }),
  };
}

describe.skipIf(!required && !(root && v2))("the browsers' kernel memory limit on a real kernel", () => {
  it("kills a browser over the limit while the server beside it keeps answering", async () => {
    expect(root, "run as root (the Cloud home's supervisor is)").toBe(true);
    expect(v2, "a cgroup v2 tree with the memory controller at /sys/fs/cgroup").toBe(true);
    // A fresh, empty cgroup of the test's own under the root one stands for the supervisor's; the test goes back to its own
    // cgroup after each spawn, as the supervisor does.
    const own = ownCgroupDir(readFileSync("/proc/self/cgroup", "utf8"))!;
    const base = join("/sys/fs/cgroup", `omb-test-${process.pid}-${Date.now()}`);
    // Under /tmp itself: the unprivileged "server" must reach it, and a runner's TMPDIR is its own, mode 0700.
    const work = mkdtempSync("/tmp/omb-cgroup-");
    chmodSync(work, 0o755);
    let server: ChildProcess | undefined;
    try {
      mkdirSync(base);
      const started = performance.now();
      const setup = setUpBrowserCgroup({ base, limitBytes: 160 * MB, ids: NOBODY });
      const took = performance.now() - started;
      console.log(`browser memory limit set up in ${took.toFixed(2)} ms`);
      expect(setup).toMatchObject({ ok: true });
      if (!setup.ok) return;
      expect(readFileSync(`${setup.group.browsers}/memory.max`, "utf8").trim()).toBe(String(160 * MB));
      // A runner has swap: the browsers may not use it, or a hog would swap rather than end.
      if (existsSync(`${setup.group.browsers}/memory.swap.max`)) expect(readFileSync(`${setup.group.browsers}/memory.swap.max`, "utf8").trim()).toBe("0");

      // "Chrome": fills memory 16 MB at a time, up to 2 GB, then waits.
      const hog = join(work, "hog.mjs");
      writeFileSync(hog, `#!${process.execPath}\nconst kept = [];\nfor (let i = 0; i < 128; i++) { kept.push(Buffer.alloc(16 * 1024 * 1024, 1)); }\nconsole.log("hog survived");\nsetInterval(() => {}, 1000);\n`);
      chmodSync(hog, 0o755);
      const launcher = join(work, "chrome-launcher.sh");
      writeFileSync(launcher, launcherScript({ chrome: hog, userAgent: "UA", screen: { width: 1280, height: 720 }, memoryGroup: setup.group.browsers }, "linux"));
      chmodSync(launcher, 0o755);

      // The "server": answers on a port, starts the launcher, and says how it ended.
      const serverScript = join(work, "server.cjs");
      writeFileSync(serverScript, [
        "const http = require('node:http'); const { spawn } = require('node:child_process'); const fs = require('node:fs');",
        "const s = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => {",
        "  console.log('port ' + s.address().port + ' cgroup ' + fs.readFileSync('/proc/self/cgroup', 'utf8').trim());",
        `  const c = spawn(${JSON.stringify(launcher)}, ['--headless'], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "  console.log('chrome ' + c.pid);",
        "  c.on('exit', (code, signal) => console.log('chrome ended ' + code + ' ' + signal));",
        "});",
      ].join("\n"));
      chmodSync(serverScript, 0o644);
      // The supervisor's cost on the start path: joining the leaf for the spawn and going back, beyond the spawn itself.
      const joinStarted = performance.now();
      spawnInCgroup(setup.group.server, own, () => undefined);
      console.log(`joining the server's leaf and going back took ${(performance.now() - joinStarted).toFixed(2)} ms`);
      server = spawnInCgroup(setup.group.server, own, () =>
        spawn(process.execPath, [serverScript], { uid: NOBODY.uid, gid: NOBODY.gid, cwd: work, stdio: ["ignore", "pipe", "inherit"] }));
      const out = lines(server);
      const first = await out.next(/^port \d+ cgroup /, 20_000);
      const port = Number(/^port (\d+)/.exec(first)![1]);
      expect(first).toMatch(new RegExp(`cgroup 0::${setup.group.server.slice("/sys/fs/cgroup".length)}$`));
      const ended = await out.next(/^chrome ended /, 60_000);
      expect(ended).toBe("chrome ended null SIGKILL");
      expect(out.all).not.toContain("hog survived");
      expect(groupOomKills(setup.group.browsers)).toBeGreaterThanOrEqual(1);
      // The server is still there, in its own leaf, and answers.
      expect(server.exitCode).toBeNull();
      expect(await answer(port)).toBe("ok");
    } finally {
      server?.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const dir of [`${base}/omb/browsers`, `${base}/omb/server`, `${base}/omb`, base]) try { rmdirSync(dir); } catch {}
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
