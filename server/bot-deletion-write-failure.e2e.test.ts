import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("preserves conversations and scheduled work when deletion cannot save, then safely retries", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const botsFile = join(dataDir, "bots.json");
  const retainedBotsFile = join(dataDir, "bots.before-delete-fixture.json");
  let faultInstalled = false;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const restoreBotsFile = () => {
    if (faultInstalled) {
      rmdirSync(botsFile); // Only the empty fixture directory installed below.
      faultInstalled = false;
    }
    if (existsSync(retainedBotsFile)) renameSync(retainedBotsFile, botsFile);
  };
  const schedules = async () => ({
    routines: (await api("GET", "/api/routines")).routines,
    webhooks: (await api("GET", "/api/webhooks")).webhooks,
    calls: (await api("GET", "/api/calendar-calls")).calls,
  });
  const scheduleDiskHashes = () => Object.fromEntries(["routines.json", "webhooks.json", "calendar-calls.json"].map(name =>
    [name, createHash("sha256").update(readFileSync(join(dataDir, name))).digest("hex")]));
  try {
    const bot = (await control("new-bot", "--name", "Deletion failure fixture")).bot;
    const guest = (await control("new-bot", "--name", "Surviving fixture guest")).bot;
    await control("send", "--bot", bot.id, "--text", "Keep this fixture conversation until deletion is saved.");
    expect(await control("wait", "--bot", bot.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    const beforeMessages = (await control("messages", "--bot", bot.id, "--limit", "20")).messages;
    const later = Date.now() + 86_400_000;
    const { routine } = await api("POST", "/api/routines", { name: "Retain this routine", botId: bot.id,
      prompt: "Prepare the fixture report.", enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: later } }, 201);
    // The webhook's one-time credential is deliberately not retained in evidence.
    const { webhook } = await api("POST", "/api/webhooks", { name: "Retain this webhook", botId: bot.id,
      prompt: "Summarize the fixture event.", enabled: true }, 201);
    const { call: solo } = await api("POST", "/api/calendar-calls", { name: "Retain this solo call", botIds: [bot.id],
      schedule: { type: "once", at: later }, durationMinutes: 10 }, 201);
    const { call: shared } = await api("POST", "/api/calendar-calls", { name: "Retain this shared call", botIds: [bot.id, guest.id],
      schedule: { type: "once", at: later }, durationMinutes: 10 }, 201);
    const before = await schedules();
    expect(before.routines.find((item: any) => item.id === routine.id)?.enabled).toBe(true);
    expect(before.webhooks.find((item: any) => item.id === webhook.id)?.enabled).toBe(true);
    const beforeBot = (await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id);
    const beforeDisk = scheduleDiskHashes();
    const originalBots = readFileSync(botsFile, "utf8");

    // An existing directory at the atomic replacement target makes rename
    // fail on the real filesystem, without production fault-injection hooks
    // or relying on chmod (which can be bypassed by a privileged test user).
    renameSync(botsFile, retainedBotsFile);
    mkdirSync(botsFile);
    faultInstalled = true;
    const failure = await api("DELETE", `/api/bots/${bot.id}`, undefined, 500);
    expect(failure.error).toBeTruthy();
    expect((await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id)).toEqual(beforeBot);
    expect((await control("messages", "--bot", bot.id, "--limit", "20")).messages).toEqual(beforeMessages);
    const afterFailure = await schedules();
    expect(afterFailure).toEqual(before);
    expect(scheduleDiskHashes()).toEqual(beforeDisk);
    expect(readFileSync(retainedBotsFile, "utf8")).toBe(originalBots);
    evidence.push({ failedDelete: failure, before, afterFailure, diskUnchanged: true, conversationUnchanged: true });

    restoreBotsFile();
    expect(await api("DELETE", `/api/bots/${bot.id}`)).toEqual({ ok: true });
    const bots = (await api("GET", "/api/bots?messages=0")).bots;
    expect(bots.some((item: any) => item.id === bot.id)).toBe(false);
    expect(bots.some((item: any) => item.id === guest.id)).toBe(true);
    const afterRetry = await schedules();
    expect(afterRetry.routines.find((item: any) => item.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(afterRetry.webhooks.find((item: any) => item.id === webhook.id)).toMatchObject({ enabled: false });
    expect(afterRetry.calls.some((item: any) => item.id === solo.id)).toBe(false);
    expect(afterRetry.calls.find((item: any) => item.id === shared.id)?.botIds).toEqual([guest.id]);
    evidence.push({ retryApplied: true, afterRetry, survivingGuest: guest.id });
  } finally {
    restoreBotsFile();
    await fixture.close();
    const evidencePath = `${logPath}.bot-deletion-write-failure.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    expect(existsSync(dataDir)).toBe(false);
    console.info(JSON.stringify({ evidencePath, logPath, fixtureRemoved: true }));
  }
}, 60_000);
