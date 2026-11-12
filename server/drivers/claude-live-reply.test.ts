// The Claude adapter against the fake CLI for each streamed reply case: each message's words and completion share one
// id, and nothing is doubled, lost, glued to another message or shown from thinking.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { replyProblems } from "../harness/text-items.testkit.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { caseTokens, LIVE_REPLY_CASES, liveReplyScripts } from "../testing/live-reply-cases.ts";
import { ClaudeDriver } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const CASES = LIVE_REPLY_CASES.filter((entry) => entry.action === undefined || entry.action === "stop");

let scratch: string;
let scripts: string;
beforeAll(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-claude-live-reply-"));
  scripts = join(scratch, "scripts.json");
  writeFileSync(scripts, JSON.stringify(liveReplyScripts()));
});
afterAll(async () => { await removeTempDir(scratch); });

describe("Claude streams each reply message under its own id", () => {
  it.each(CASES.map((entry) => ({ entry, name: entry.name })))("$name", async ({ entry }) => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-live-reply",
      displayName: "Claude live reply",
      environment: { FAKE_STREAM_SCRIPT: scripts, FAKE_STREAM_CADENCE: entry.action === "stop" ? "6:5" : "7:0" },
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const threadId = `claude-live-${entry.name}`;
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: `Please answer ${entry.marker}`, approvalMode: "full" });
      if (entry.action === "stop") {
        await recorder.until((event) => event.type === "content.delta" && event.turnId === turnId, 30_000);
        await instance.adapter.interruptTurn(threadId);
      }
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
      const events = recorder.events.filter((event) => event.turnId === turnId);
      expect(replyProblems(events, caseTokens(entry), { stopped: entry.action === "stop" })).toEqual([]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }, 60_000);
});
