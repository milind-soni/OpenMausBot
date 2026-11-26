// The whole way round with a real package manager: a conversation's npm install is shed while it is idle, its bot is
// told, and the reinstall the note asks for brings the same package back from the lockfile. No network: the package is
// a tarball packed here.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConversationFolderCleanup } from "./conversation-folder-cleanup.ts";
import { idleReclaimNote, reclaimIdle } from "./idle-reclaim.ts";

const DAY = 24 * 60 * 60 * 1000;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const hasNpm = (() => { try { execFileSync(npm, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }); return true; } catch { return false; } })();

function age(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY);
  const walk = (one: string) => {
    const stats = lstatSync(one);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) for (const name of readdirSync(one)) walk(join(one, name));
    utimesSync(one, at, at);
  };
  walk(path);
}

describe("a resumed conversation reinstalls", () => {
  it.skipIf(!hasNpm || process.platform === "win32")("sheds an idle conversation's npm install, tells its bot, and npm ci brings it back", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "omb-idle-reinstall-"));
    made.push(sandbox);
    const env = { ...process.env, npm_config_cache: join(sandbox, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
    const run = (args: string[], cwd: string) => execFileSync(npm, args, { cwd, env, stdio: "pipe" }).toString();
    // A tiny package, packed into a tarball the project depends on.
    const source = join(sandbox, "tiny");
    mkdirSync(source);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "omb-tiny", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(source, "index.js"), "module.exports = () => 'tiny works';\n");
    const tarball = join(sandbox, run(["pack", "--silent", "--pack-destination", sandbox], source).trim().split("\n").at(-1)!);
    const dataDir = join(sandbox, "data");
    const project = join(dataDir, "task-workspaces", "scout", "t1", "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true }));
    run(["install", "--offline", tarball], project);
    const check = () => execFileSync(process.execPath, ["-e", "process.stdout.write(require('omb-tiny')())"], { cwd: project }).toString();
    expect(check()).toBe("tiny works");
    age(dataDir, 10);

    const lastMessage = Date.now() - 10 * DAY;
    const records = () => ({ bots: [{ id: "scout", tasks: [{ threadId: "t1", updatedAt: lastMessage }] }], groups: [] });
    const cleanup = createConversationFolderCleanup({ dataDir, records, processFolders: async () => [], drainAfterMs: false, pause: async () => {}, log: () => {}, warn: () => {} });
    const report = await reclaimIdle({
      dataDir, mode: () => "remove", records, busy: () => false, botBusy: () => false, handedOff: () => false, cleanup,
      volume: async () => ({ usedBytes: 95, freeBytes: 5 }), openPaths: async () => [], pause: async () => {}, log: () => {}, warn: () => {},
    });
    expect(report.folders).toBe(1);
    expect(existsSync(join(project, "node_modules"))).toBe(false);
    expect(existsSync(join(project, "package-lock.json"))).toBe(true);
    expect(() => check()).toThrow();
    const note = idleReclaimNote(dataDir, "t1");
    expect(note).toContain("app/node_modules");
    expect(note).toContain("npm ci");

    // What the note asks the bot to do.
    run(["ci", "--offline"], project);
    expect(check()).toBe("tiny works");
  }, 120_000);
});
