import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { antigravityTokenPath } from "./antigravity-acp.ts";
import { watchAntigravityPromptOutcome } from "./antigravity-turn-outcome.ts";
import { AntigravityDriver } from "./antigravity.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const TOOL = 8;
const ERROR_MESSAGE = 17;
const NAME = "Google Gemini (Antigravity)";
const USAGE_LIMIT = `This ${NAME} account has reached its usage limit. Wait for it to reset, or switch this bot to another AI.`;

// Error-step payloads trimmed from Antigravity 1.4.5 against a local Gemini endpoint.
const errorText = (error: string) =>
  `\n$Agent execution terminated due to error.\u0012agent executor error: ${error}: ${error}\n(1) attached stack trace\n  -- stack trace:`;
// An unparsable reset timestamp must not hide the reset delay, nor a retry delay outrank it.
const QUOTA_ERROR = errorText(
  "Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s] map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:soon] reason:QUOTA_EXHAUSTED]]",
);
const RATE_LIMIT_ERROR = errorText(
  "Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com reason:RATE_LIMIT_EXCEEDED] map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s]]",
);
const INVALID_ARGUMENT_ERROR = errorText("Error 400, Message: Request contains an invalid argument., Status: INVALID_ARGUMENT, Details: []");
const UNAVAILABLE_ERROR = errorText("Error 503, Message: The service is currently unavailable., Status: UNAVAILABLE, Details: []");
const TIMESTAMP_ERROR = errorText(
  "Error 429, Message: Quota exhausted., Status: RESOURCE_EXHAUSTED, Details: [map[metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:2026-11-20T10:00:00Z] reason:QUOTA_EXHAUSTED]]",
);
// The model's reply quoting the agent's quota notice is an ordinary planner response.
const QUOTED_NOTICE = "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.";

const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function profile(): { directory: string; conversations: string } {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-outcome-"));
  scratch.push(directory);
  const conversations = join(directory, "antigravity-acp", "conversations");
  mkdirSync(conversations, { recursive: true });
  return { directory, conversations };
}

function append(file: string, steps: ReadonlyArray<readonly [number, string]>): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
    const insert = database.prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)");
    for (const [type, payload] of steps) insert.run(type, Buffer.from(payload));
  } finally {
    database.close();
  }
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("watchAntigravityPromptOutcome", () => {
  it("fails only turns whose own steps end in an upstream error", async () => {
    const { directory, conversations } = profile();
    const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
    const turn = async (steps: ReadonlyArray<readonly [number, string]>, result: object = { stopReason: "end_turn" }) => {
      const check = await watchAntigravityPromptOutcome(NAME, directory, sessionId, () => 0);
      if (steps.length) append(join(conversations, `${sessionId}.db`), steps);
      return check(result);
    };
    const input = "Run the fixture.";
    const reply = "FIXTURE_OK";

    // The first prompt creates the session log.
    expect(await turn([[USER_INPUT, input], [PLANNER_RESPONSE, reply]])).toBeUndefined();
    const quota = await turn([[USER_INPUT, input], [ERROR_MESSAGE, QUOTA_ERROR]]);
    expect(quota).toMatchObject({ acpUsageLimit: true, facts: { limitResetsAt: 3_600_000, text: { key: "chat.notice.usageLimitResets" } } });
    expect(quota!.message).toMatch(new RegExp(`^This ${NAME.replace(/[()]/g, "\\$&")} account has reached its usage limit, which resets .+\\. Until then, switch this bot to another AI\\.$`));
    // The earlier error step is outside this turn.
    expect(await turn([[USER_INPUT, input], [PLANNER_RESPONSE, QUOTED_NOTICE]], { stopReason: "end_turn", usage: { inputTokens: 42, outputTokens: 3, totalTokens: 54 } }))
      .toBeUndefined();
    expect(await turn([[USER_INPUT, input], [ERROR_MESSAGE, RATE_LIMIT_ERROR]])).toMatchObject({ acpUsageLimit: true, facts: { limitResetsAt: 42_000 } });
    expect(await turn([[USER_INPUT, input], [ERROR_MESSAGE, TIMESTAMP_ERROR]]))
      .toMatchObject({ acpUsageLimit: true, facts: { limitResetsAt: Date.parse("2026-11-20T10:00:00Z") } });
    const invalid = await turn([[USER_INPUT, input], [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR]]);
    expect(invalid).toMatchObject({ acpUsageLimit: false, message: `${NAME} stopped with an error (HTTP 400; ${NAME} says: "Request contains an invalid argument").` });
    expect(invalid!.facts.limitResetsAt).toBeUndefined();
    expect((await turn([[USER_INPUT, input], [ERROR_MESSAGE, UNAVAILABLE_ERROR]]))!.message)
      .toBe(`${NAME} had a temporary server problem (HTTP 503; ${NAME} says: "The service is currently unavailable"). Try again in a few minutes.`);
    expect(await turn([[USER_INPUT, input], [ERROR_MESSAGE, "no api error here"]])).toMatchObject({ acpUsageLimit: false, message: `${NAME} stopped with an error.` });
    // A completed tool keeps its usage, and the turn still fails.
    expect(await turn([[USER_INPUT, input], [PLANNER_RESPONSE, reply], [TOOL, reply], [ERROR_MESSAGE, QUOTA_ERROR]], { stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 5 } }))
      .toMatchObject({ acpUsageLimit: true });
    expect(await turn([[USER_INPUT, input], [PLANNER_RESPONSE, reply]])).toBeUndefined();
    // The agent maps the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
    const refusal = await turn([], { stopReason: "refusal" });
    expect(refusal).toMatchObject({ acpUsageLimit: true, message: USAGE_LIMIT });
    expect(refusal!.facts.limitResetsAt).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("reads only this session's own unlinked log, and keeps a typed refusal", async () => {
    const { directory, conversations } = profile();
    const own = "e6aba774-5472-4277-b6ee-27b2e05570a7";
    const peer = "0d9c2b4e-1111-4222-8333-944455556666";

    // own.db links to a peer session; the peer's new error step is not this turn's.
    append(join(conversations, `${peer}.db`), [[USER_INPUT, "peer"]]);
    symlinkSync(join(conversations, `${peer}.db`), join(conversations, `${own}.db`));
    const linked = await watchAntigravityPromptOutcome(NAME, directory, own);
    append(join(conversations, `${peer}.db`), [[ERROR_MESSAGE, QUOTA_ERROR]]);
    expect(await linked({ stopReason: "end_turn" })).toBeUndefined();
    expect(await linked({ stopReason: "refusal" })).toMatchObject({ acpUsageLimit: true });

    // An unreadable log gives no evidence, but the agent's typed refusal still fails the turn.
    rmSync(join(conversations, `${own}.db`));
    writeFileSync(join(conversations, `${own}.db`), "not a database");
    const corrupt = await watchAntigravityPromptOutcome(NAME, directory, own);
    expect(await corrupt({ stopReason: "end_turn" })).toBeUndefined();
    expect(await corrupt({ stopReason: "refusal" })).toMatchObject({ acpUsageLimit: true, message: USAGE_LIMIT });
  });

  it("gives no failure for a session id that is no file name, a missing profile, or a log replaced during the prompt", async () => {
    const { directory, conversations } = profile();
    expect(await (await watchAntigravityPromptOutcome(NAME, directory, "../escape"))({ stopReason: "end_turn" })).toBeUndefined();
    expect(await (await watchAntigravityPromptOutcome(NAME, join(directory, "absent"), "session"))({ stopReason: "end_turn" })).toBeUndefined();
    const file = join(conversations, "session.db");
    append(file, [[USER_INPUT, "first"]]);
    const check = await watchAntigravityPromptOutcome(NAME, directory, "session");
    rmSync(file);
    append(join(conversations, "other.db"), [[USER_INPUT, "hold the inode"]]);
    append(file, [[USER_INPUT, "second"], [USER_INPUT, "third"], [ERROR_MESSAGE, QUOTA_ERROR]]);
    expect(await check({ stopReason: "end_turn" })).toBeUndefined();
  });
});

describe("an Antigravity turn whose reply was an upstream failure", () => {
  const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");

  async function instance(instanceId: string, steps: Array<[number, string]> | null) {
    ensureDirs();
    const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-outcome-"));
    scratch.push(directory);
    const executable = join(directory, "fake-antigravity.ts");
    const harness = join(directory, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
    copyFileSync(join(TESTING, "fake-acp-cli.ts"), executable);
    copyFileSync(join(TESTING, "fake-acp-cli.ts"), harness);
    if (process.platform !== "win32") for (const file of [executable, harness]) chmodSync(file, 0o755);
    const token = antigravityTokenPath(instanceId);
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, "{}", { mode: 0o600 });
    const stepsFile = join(directory, "steps.json");
    if (steps) writeFileSync(stepsFile, JSON.stringify(steps));
    const created = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true,
      config: { cli: executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Google Antigravity", FAKE_ACP_AGENT_VERSION: "1.4.5", FAKE_ACP_AGY_STEPS_FILE: stepsFile },
    });
    instances.push(created);
    return { created, directory, stepsFile };
  }

  it("shows the usage limit with its reset, and the next turn answers once the limit is gone", async () => {
    const { created, directory, stepsFile } = await instance("antigravity-outcome-quota", [[USER_INPUT, "hello"], [ERROR_MESSAGE, QUOTA_ERROR]]);
    const recorder = recordEvents(created.adapter);
    const before = Date.now();
    const { turnId } = await created.adapter.sendTurn({ threadId: "quota", text: "hello", approvalMode: "full", cwd: directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    const error = events.find((event) => event.type === "runtime.error") as { message: string; limit?: string; limitResetsAt?: number; text?: { key: string } };
    expect(error.message).toMatch(/account has reached its usage limit, which resets .+\. Until then, switch this bot to another AI\.$/);
    expect(error).toMatchObject({ limit: "engine", text: { key: "chat.notice.usageLimitResets" } });
    expect(error.limitResetsAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(error.limitResetsAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "quota" });

    writeFileSync(stepsFile, JSON.stringify([[USER_INPUT, "again"], [PLANNER_RESPONSE, "fine"]]));
    const next = await created.adapter.sendTurn({ threadId: "quota", text: "again", approvalMode: "full", cwd: directory });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === next.turnId);
    const later = recorder.events.filter((event) => event.turnId === next.turnId);
    expect(later.some((event) => event.type === "runtime.error")).toBe(false);
    expect(later.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  }, 90_000);

  it("leaves a normal reply, and a runtime that keeps no log, alone", async () => {
    for (const [instanceId, steps] of [["antigravity-outcome-fine", [[USER_INPUT, "hello"], [PLANNER_RESPONSE, "fine"]]], ["antigravity-outcome-no-log", null]] as const) {
      const { created, directory } = await instance(instanceId, steps as Array<[number, string]> | null);
      const recorder = recordEvents(created.adapter);
      const { turnId } = await created.adapter.sendTurn({ threadId: instanceId, text: "hello", approvalMode: "full", cwd: directory });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const events = recorder.events.filter((event) => event.turnId === turnId);
      expect(events.some((event) => event.type === "runtime.error")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    }
  }, 90_000);
});
