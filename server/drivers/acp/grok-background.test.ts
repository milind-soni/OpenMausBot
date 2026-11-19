// Ending a Grok session's background work: a finished subagent or shell command wakes a turn nobody prompted, against the
// scripted ACP peer where session/close ends the job.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const scratches: string[] = [];
afterEach(async () => { for (const dir of scratches.splice(0)) await removeTempDir(dir); });

const start = async (id: string, extra: Record<string, string> = {}) => {
  ensureDirs();
  const scratch = mkdtempSync(join(tmpdir(), "omb-grok-background-"));
  scratches.push(scratch);
  mkdirSync(join(scratch, "grok"), { recursive: true });
  writeFileSync(join(scratch, "grok", "auth.json"), "{}");
  const files = { woken: join(scratch, "woken"), rpc: join(scratch, "rpc.jsonl") };
  const instance = await GrokAgentDriver.create({
    instanceId: id,
    displayName: "Grok",
    enabled: true,
    environment: {
      GROK_HOME: join(scratch, "grok"), FAKE_ACP_MODE: "background-wake", FAKE_ACP_NO_FORK: "1", FAKE_ACP_CLOSE_ENDS_JOBS: "1",
      FAKE_ACP_WOKEN_FILE: files.woken, FAKE_ACP_RPC_APPEND_FILE: files.rpc, FAKE_ACP_STEP_MS: "100", ...extra,
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  const recorder = recordEvents(instance.adapter);
  const calls = () => existsSync(files.rpc)
    ? readFileSync(files.rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; sessionId?: string }) : [];
  const steps = () => existsSync(files.woken) ? readFileSync(files.woken, "utf8").trim().split("\n").length : 0;
  const ask = async (threadId: string, text: string) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId, text });
    return recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  };
  return { instance, recorder, calls, steps, ask };
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const promptedSession = (calls: () => Array<{ method: string; sessionId?: string }>) =>
  calls().filter((call) => call.method === "session/prompt").at(-1)?.sessionId;

describe("Grok background work", () => {
  it("ends a turn its background job wakes between ours, drops its output, and goes on in the same session", async () => {
    const { instance, recorder, calls, steps, ask } = await start("grok-background-wake");
    const threadId = "t-grok-background-wake";
    try {
      expect(await ask(threadId, "build it")).toMatchObject({ ok: true });
      const session = promptedSession(calls)!;
      await until(() => calls().some((call) => call.method === "session/close" && call.sessionId === session));
      const woken = steps();
      await pause(400);
      expect(steps()).toBe(woken);
      expect(JSON.stringify(recorder.events)).not.toContain("WOKEN");
      expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);

      const second = await ask(threadId, "and now?");
      expect(second).toMatchObject({ ok: true });
      expect(JSON.stringify(recorder.events.filter((event) => "turnId" in event && event.turnId === second.turnId))).toContain("second answer");
      expect(calls().filter((call) => call.method === "session/load").at(-1)?.sessionId).toBe(session);
      expect(promptedSession(calls)).toBe(session);
      expect(JSON.stringify(recorder.events)).not.toContain("WOKEN");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("ends the session's background work when the person stops the turn, before it can wake a turn", async () => {
    const { instance, recorder, calls, steps, ask } = await start("grok-background-stop", { FAKE_ACP_WAKE_MS: "1500" });
    const threadId = "t-grok-background-stop";
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "build it STOP_ME" });
      await until(() => JSON.stringify(recorder.events).includes("build started"));
      const startedAt = Date.now();
      await instance.adapter.interruptTurn(threadId);
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ stopReason: "cancelled" });
      const session = promptedSession(calls)!;
      await until(() => calls().some((call) => call.method === "session/close" && call.sessionId === session));
      await pause(Math.max(0, 1_800 - (Date.now() - startedAt)));
      expect(steps()).toBe(0);
      expect(await ask(threadId, "go on")).toMatchObject({ ok: true });
      expect(promptedSession(calls)).toBe(session);
      expect(JSON.stringify(recorder.events)).not.toContain("WOKEN");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
