// Every ACP engine's adapter against the scripted ACP peer, for each streamed reply case: the words and completion of
// each message share one id, and nothing is doubled, lost, glued to another message or shown from thinking.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, RuntimeEvent } from "../../contracts.ts";
import { replyProblems } from "../../harness/text-items.testkit.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { caseTokens, LIVE_REPLY_CASES, liveReplyScripts } from "../../testing/live-reply-cases.ts";
import type { AcpConfig } from "./core.ts";
import { ClineAgentDriver } from "./cline.ts";
import { CommandCodeAgentDriver } from "./command-code.ts";
import { CopilotAgentDriver } from "./copilot.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { CustomAcpDriver } from "./custom.ts";
import { DeepSeekAgentDriver } from "./deepseek.ts";
import { DroidAgentDriver } from "./droid.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { KiroAgentDriver } from "./kiro.ts";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { QwenAgentDriver } from "./qwen.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const OpenCodeDriver = createOpenCodeDriver(async () => ({
  default: "opencode/fixture-model",
  options: [{ id: "opencode/fixture-model", label: "Fixture model" }],
}));
const ENGINES: ProviderDriver<AcpConfig>[] = [
  OpenCodeDriver, HermesAgentDriver, GeminiAgentDriver, KimiAgentDriver, QwenAgentDriver, GrokAgentDriver, DeepSeekAgentDriver,
  DroidAgentDriver, CommandCodeAgentDriver, KiroAgentDriver, CursorAgentDriver, ClineAgentDriver, CopilotAgentDriver, CustomAcpDriver,
] as ProviderDriver<AcpConfig>[];
const CASES = LIVE_REPLY_CASES.filter((entry) => entry.action === undefined || entry.action === "stop");

let scratch: string;
let scripts: string;
beforeAll(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-live-reply-acp-"));
  scripts = join(scratch, "scripts.json");
  writeFileSync(scripts, JSON.stringify(liveReplyScripts()));
});
afterAll(async () => { await removeTempDir(scratch); });

describe.each(ENGINES.map((driver) => ({ driver, kind: driver.driverKind })))("$kind streams each reply message under its own id", ({ driver }) => {
  it.each(CASES.map((entry) => ({ entry, name: entry.name })))("$name", async ({ entry }) => {
    const home = mkdtempSync(join(scratch, `${driver.driverKind}-`));
    const instance = await driver.create({
      instanceId: `live-reply-${driver.driverKind}`,
      displayName: "Live reply fixture",
      enabled: true,
      environment: {
        HOME: home, USERPROFILE: home, HERMES_HOME: join(home, ".hermes"), CLINE_DATA_DIR: join(home, "cline"), CLINE_PROVIDER: "openai-compatible", CLINE_MODEL: "fixture-model", CLINE_API_KEY: "fixture-only", KIMI_CODE_HOME: join(home, ".kimi"),
        OPENMAUSBOT_PROBE_LOCAL_INJECT: "0", OPENCODE_API_KEY: "fixture-only", DEEPSEEK_API_KEY: "fixture-only", KIRO_API_KEY: "fixture-only", FAKE_ACP_AUTOPILOT: "1",
        FAKE_STREAM_SCRIPT: scripts, FAKE_STREAM_CADENCE: entry.action === "stop" ? "6:5" : "7:0",
      },
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: `live-${entry.name}`, text: `Please answer ${entry.marker}`, cwd: home, approvalMode: "full" });
      if (entry.action === "stop") {
        await recorder.until((event) => event.type === "content.delta" && event.turnId === turnId);
        await instance.adapter.interruptTurn(`live-${entry.name}`);
      }
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
      const events = recorder.events.filter((event): event is RuntimeEvent => event.turnId === turnId);
      expect(replyProblems(events, caseTokens(entry), { stopped: entry.action === "stop" })).toEqual([]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }, 60_000);
});
