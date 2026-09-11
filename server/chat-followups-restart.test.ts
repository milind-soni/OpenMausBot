import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("survives a real server crash: queued sends keep receipts, cancellation and uncertain dispatch never replay", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json() as any;
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages as any[];
  const prompts = (thread: string): any[] => {
    try { return readFileSync(join(dataDir, `${thread}.prompts`), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const journal = () => {
    const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT id, status FROM chat_followups ORDER BY rowid").all(); }
    finally { db.close(); }
  };
  const restart = async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1), PATH: dirname(process.execPath),
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const wrapper = join(dataDir, "queued-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync } from "node:fs";',
      'import { basename, join } from "node:path";',
      'const thread = basename(process.cwd());',
      `const home = ${JSON.stringify(dataDir)};`,
      'process.env.FAKE_CLAUDE_MODE = existsSync(join(home, "restarted")) ? "happy" : "slow";',
      'process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(home, thread + ".gate");',
      'process.env.FAKE_CLAUDE_PROMPTS = join(home, thread + ".prompts");',
      // Crash the server, not unrelated processes: a fixture provider exits
      // when its parent's pipe closes, even if its fake finish gate is shut.
      'process.stdin.on("end", () => process.exit(0));',
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url))).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const bot = (await api("POST", "/api/bots", { name: "Durable follow-ups" }, 201)).bot;
    const uncertain = (await api("POST", "/api/bots", { name: "Uncertain follow-up" }, 201)).bot;
    const later = (await api("POST", `/api/bots/${uncertain.id}/tasks`, { title: "In-flight receipt" }, 201)).task;
    const worker = (await api("POST", "/api/bots", { name: "Channel worker" }, 201)).bot;
    const channel = (await api("POST", "/api/groups", {
      name: "Durable channel", memberIds: [worker.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: worker.id } },
    }, 201)).group;

    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Working before restart", threadId: bot.threadId }, 202);
    await expect.poll(() => prompts(bot.threadId).length, { timeout: 15_000 }).toBe(1);
    const replyToId = (await messages(bot.threadId)).find((message) => message.role === "user").id;
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const image = join(attachments, "123e4567-e89b-42d3-a456-426614174000.png");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7f8AAAAASUVORK5CYII=", "base64"));
    const text = `Inspect screenshot after the first task\n\n<attached-image path="${image}" name="fixture.png" />`;
    const body = { text, threadId: bot.threadId, replyToId, sendId: "durable_bot_send_123456" };
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, body, 202);
    expect(queued).toMatchObject({ queued: true, queueId: expect.any(String) });
    const cancelledBody = { ...body, text: `${text}\n\nCancelled task`, sendId: "cancelled_bot_send_123456" };
    const cancelled = await api("POST", `/api/bots/${bot.id}/messages`, cancelledBody, 202);
    await api("DELETE", `/api/bots/${bot.id}/queue/${cancelled.queueId}`, { threadId: bot.threadId });

    await api("POST", `/api/bots/${uncertain.id}/messages`, { threadId: uncertain.threadId, text: "Hold capacity" }, 202);
    const uncertainBody = { threadId: later.threadId, text: "A possibly executed action", sendId: "uncertain_bot_send_123456" };
    const claimed = await api("POST", `/api/bots/${uncertain.id}/messages`, uncertainBody, 202);
    expect(claimed).toMatchObject({ queued: true, reason: "capacity" });
    writeFileSync(join(dataDir, `${uncertain.threadId}.gate`), "finish first task only");
    await expect.poll(() => prompts(later.threadId).length, { timeout: 15_000 }).toBe(1);

    // Stop revokes provider credentials before the provider reports completion;
    // it must still retire the already-dispatched queue receipt exactly once.
    const stopped = (await api("POST", "/api/bots", { name: "Stopped follow-up" }, 201)).bot;
    const stoppedTask = (await api("POST", `/api/bots/${stopped.id}/tasks`, { title: "Stop this follow-up" }, 201)).task;
    await api("POST", `/api/bots/${stopped.id}/messages`, { threadId: stopped.threadId, text: "Hold capacity before Stop" }, 202);
    const stoppedBody = { threadId: stoppedTask.threadId, text: "Stop this dispatched follow-up", sendId: "stopped_bot_send_123456" };
    const stoppedReceipt = await api("POST", `/api/bots/${stopped.id}/messages`, stoppedBody, 202);
    expect(stoppedReceipt).toMatchObject({ queued: true, reason: "capacity" });
    writeFileSync(join(dataDir, `${stopped.threadId}.gate`), "release capacity for the stopped follow-up");
    await expect.poll(() => prompts(stoppedTask.threadId).length, { timeout: 15_000 }).toBe(1);
    expect(journal()).toContainEqual({ id: stoppedReceipt.queueId, status: "dispatching" });
    await api("POST", `/api/bots/${stopped.id}/interrupt`, { threadId: stoppedTask.threadId });
    await expect.poll(() => journal().some((row) => row.id === stoppedReceipt.queueId), { timeout: 5_000 }).toBe(false);
    expect((await api("POST", `/api/bots/${stopped.id}/messages`, stoppedBody, 202)).message.queueId).toBe(stoppedReceipt.queueId);

    const initial = await api("POST", `/api/groups/${channel.id}/messages`, { text: "Working channel" }, 202);
    const channelBody = { text: "Channel follow-up after restart", threadId: channel.threadId,
      replyToId: initial.message.id, sendId: "durable_channel_send_123456", mode: "chat" };
    const channelQueued = await api("POST", `/api/groups/${channel.id}/messages`, channelBody, 202);
    expect(channelQueued).toMatchObject({ queued: true, queueId: expect.any(String) });
    const channelCancelledBody = { ...channelBody, text: "Never run cancelled channel task", sendId: "cancelled_channel_send_123456" };
    const channelCancelled = await api("POST", `/api/groups/${channel.id}/messages`, channelCancelledBody, 202);
    await api("DELETE", `/api/groups/${channel.id}/queue/${channelCancelled.queueId}`);
    expect(journal()).toEqual(expect.arrayContaining([
      { id: queued.queueId, status: "pending" }, { id: cancelled.queueId, status: "cancelled" },
      { id: claimed.queueId, status: "dispatching" }, { id: channelQueued.queueId, status: "pending" },
    ]));

    await waitForExit(fixture.child, { signal: "SIGKILL" });
    writeFileSync(join(dataDir, "restarted"), "allow restored fake turns to finish");
    await restart();
    expect((await messages(stoppedTask.threadId)).some((message) => message.queueId === stoppedReceipt.queueId && message.kind === "activity")).toBe(false);
    expect(prompts(stoppedTask.threadId)).toHaveLength(1);
    await expect.poll(async () => (await messages(bot.threadId)).filter((message) => message.sendId === body.sendId).length, { timeout: 15_000 }).toBe(1);
    const settled = await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--url", url]);
    expect(settled).toMatchObject({ status: "settled" });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, body, 202)).message).toMatchObject({
      sendId: body.sendId, queueId: queued.queueId, replyToId, text,
    });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, cancelledBody, 409)).error).toContain("cancelled");
    expect(prompts(bot.threadId)).toHaveLength(2);
    expect(prompts(bot.threadId)[1].message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));

    await expect.poll(async () => (await messages(channel.threadId)).filter((message) => message.sendId === channelBody.sendId).length, { timeout: 15_000 }).toBe(1);
    expect((await api("POST", `/api/groups/${channel.id}/messages`, channelBody, 202)).message).toMatchObject({
      text: channelBody.text, queueId: channelQueued.queueId, replyToId: initial.message.id, channelMode: "chat", via: "api",
    });
    expect((await api("POST", `/api/groups/${channel.id}/messages`, channelCancelledBody, 409)).error).toContain("cancelled");
    const channelSettled = await runControlOmb(["wait", "--channel", channel.id, "--url", url]);
    expect(channelSettled).toMatchObject({ status: "settled" });
    await expect.poll(() => journal().some((row) => row.id === queued.queueId || row.id === channelQueued.queueId)).toBe(false);
    const interrupted = await messages(later.threadId);
    expect(interrupted.filter((message) => message.queueId === claimed.queueId)).toEqual([
      expect.objectContaining({ role: "user", text: uncertainBody.text, sendId: uncertainBody.sendId }),
      expect.objectContaining({ kind: "activity", tool: { name: expect.stringContaining("Review the result"), ok: false } }),
    ]);
    expect((await api("POST", `/api/bots/${uncertain.id}/messages`, uncertainBody, 202)).message.queueId).toBe(claimed.queueId);
    expect(prompts(later.threadId)).toHaveLength(1);
    // A second boot must not duplicate recovery notices or replay a claim.
    await waitForExit(restarted, { signal: "SIGTERM" });
    await restart();
    expect((await messages(later.threadId)).filter((message) => message.queueId === claimed.queueId)).toEqual(interrupted.filter((message) => message.queueId === claimed.queueId));
    expect(prompts(later.threadId)).toHaveLength(1);
    evidence.push({ settled, channelSettled, journal: journal(), recoveredBot: await messages(bot.threadId), recoveredChannel: await messages(channel.threadId), interrupted });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    const evidencePath = `${logPath}.chat-followups-restart.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);
