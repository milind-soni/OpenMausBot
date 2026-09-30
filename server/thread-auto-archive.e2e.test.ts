// Launcher-managed startup regressions for the auto-archive sweep (#1280,
// #1286 hold): the boot sweep archives a long-closed thread, and leaves
// alone one that is snoozed, pinned, carrying queued work, or explicitly
// restored — restore keeps closedBy, so without the exemption the very
// next startup sweep would file the thread away again.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

it("startup sweep archives long-closed threads but not snoozed, pinned, queued, restored, or peer-conversation ones", async () => {
  // Hang mode keeps every started turn in flight: three running threads
  // fill the default capacity of 3, so the fourth send lands in the
  // durable queue instead of starting a turn — the queued-work state the
  // boot sweep has to respect after the restart restores it.
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return await response.json() as any;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Archive sweep" })).bot;
    const task = async (title: string) => (await api("POST", `/api/bots/${bot.id}/tasks`, { title })).task;
    const send = (threadId: string, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId, text });
    const plain = await task("Plain long-closed");
    const snoozed = await task("Snoozed long-closed");
    const pinned = await task("Pinned long-closed");
    const queued = await task("Queued work long-closed");
    const restored = await task("Restored long-closed");
    const pairRow = await task("Pair conversation long-closed");

    // Three in-flight turns fill the bot's default thread capacity.
    await send(bot.threadId, "Runner one, stay in flight");
    const runnerTwo = await task("Runner two");
    await send(runnerTwo.threadId, "Runner two, stay in flight");
    const runnerThree = await task("Runner three");
    await send(runnerThree.threadId, "Runner three, stay in flight");
    const botsFile = join(dataDir, "bots.json");
    const botRecord = (): any => JSON.parse(readFileSync(botsFile, "utf8")).find((record: any) => record.id === bot.id);
    // busy is in-memory state (disk only catches it on unrelated saves), so
    // the poll watches the API's own view of the threads.
    const busyThreads = async (): Promise<number> => {
      const viewed = (await api("GET", "/api/bots?messages=0")).bots.find((record: any) => record.id === bot.id);
      return viewed.tasks.filter((task: any) => task.busy === true).length;
    };
    const busyDeadline = Date.now() + 20_000;
    let busy = 0;
    while ((busy = await busyThreads()) < 3 && Date.now() < busyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(busy, readFileSync(logPath, "utf8").slice(-4_000)).toBe(3);
    const queuedReceipt = await send(queued.threadId, "Still waiting for a slot to run");
    expect(queuedReceipt.queued).toBe(true);

    await api("PATCH", `/api/bots/${bot.id}/tasks/${snoozed.threadId}`, { snoozedUntil: Date.now() + 365 * DAY_MS });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${pinned.threadId}`, { pinned: true });
    // Archive by hand, then explicitly restore. closedBy.at survives the
    // restore, so the startup sweep must see the restore stamp instead.
    await api("PATCH", `/api/bots/${bot.id}/tasks/${restored.threadId}`, { archivedAt: Date.now() });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${restored.threadId}`, { archivedAt: null });
    const beforeRestart = botRecord();
    const beforeTask = (threadId: string) => beforeRestart.tasks.find((task: any) => task.threadId === threadId);
    expect(beforeTask(restored.threadId).closedBy).toBeUndefined();
    expect(beforeTask(restored.threadId).archivedAt).toBeUndefined();
    expect(beforeTask(queued.threadId).busy).toBeUndefined();

    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // The original child is gone; only its owned temporary store is edited:
    // every probe thread closed two days ago, against a one-day window.
    const closedAt = Date.now() - 2 * DAY_MS;
    const bots = JSON.parse(readFileSync(botsFile, "utf8"));
    const probe = new Set([plain, snoozed, pinned, queued, restored, pairRow].map((task) => task.threadId));
    for (const record of bots) {
      if (record.id !== bot.id) continue;
      for (const task of record.tasks) {
        if (probe.has(task.threadId)) task.closedBy = { botId: bot.id, name: bot.name, at: closedAt };
        // The standing pair row: resolvePairConversation reuses it when the
        // peer writes again, so the sweep must never archive it.
        if (task.threadId === pairRow.threadId) {
          task.openedBy = { botId: "peer-sender", name: "Peer sender", kind: "pair", at: closedAt };
        }
      }
    }
    writeFileSync(botsFile, JSON.stringify(bots, null, 2));
    const configFile = join(dataDir, "config.json");
    const storedConfig = JSON.parse(readFileSync(configFile, "utf8"));
    storedConfig.threads = { ...storedConfig.threads, maxConcurrentPerBot: 3, autoArchiveDays: 1 };
    writeFileSync(configFile, JSON.stringify(storedConfig, null, 2));

    // Restart through the same launcher-managed path the routines recovery
    // test uses, with the fake CLI back to settling turns normally.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
      PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    // The sweep runs before the listener answers, so /api/health responding
    // is itself the evidence that the startup sweep has already run.
    let ready = false;
    const readyDeadline = Date.now() + 20_000;
    while (Date.now() < readyDeadline) {
      expect(restarted.exitCode, `restarted server exited; see ${logPath}`).toBeNull();
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) { ready = true; break; }
      } catch {
        // The replacement child is still starting its listener.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(ready).toBe(true);

    const after = botRecord();
    const archivedAt = (threadId: string) => after.tasks.find((task: any) => task.threadId === threadId)?.archivedAt ?? null;
    expect(archivedAt(plain.threadId), readFileSync(logPath, "utf8").slice(-4_000)).not.toBeNull();
    expect(archivedAt(snoozed.threadId)).toBeNull();
    expect(archivedAt(pinned.threadId)).toBeNull();
    expect(archivedAt(queued.threadId)).toBeNull();
    expect(archivedAt(restored.threadId)).toBeNull();
    expect(archivedAt(pairRow.threadId)).toBeNull();
    expect(readFileSync(logPath, "utf8")).toContain("[auto-archive] archived 1 long-closed thread(s)");

    // The API view agrees, and the restored thread is still closed-but-out,
    // with its close stamp intact — the exact hold scenario from #1286.
    const viewed = (await api("GET", "/api/bots?messages=0")).bots.find((record: any) => record.id === bot.id);
    const viewOf = (threadId: string) => viewed.tasks.find((task: any) => task.threadId === threadId);
    expect(viewOf(plain.threadId).archivedAt).not.toBeNull();
    expect(viewOf(restored.threadId).archivedAt).toBeUndefined();
    expect(viewOf(restored.threadId).closedBy?.at).toBe(closedAt);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
