import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { appendPromptPlan, type NativePromptPlan } from "./prompt-plan.ts";

const basePlan = (): NativePromptPlan => ({
  mode: "resume",
  owner: "room",
  botId: "bot-receipt",
  providerInstanceId: "provider-receipt",
  systemBuiltBytes: 10,
  systemSentBytes: 4,
  turnTextBytes: 5,
  recoveryTextBytes: 0,
  sections: [{ id: "memory", bytes: 4, sent: true }],
  roomMessagesSent: 1,
  roomMessagesRetained: 3,
  reason: "resume",
});

describe("prompt.plan writer", () => {
  beforeAll(() => ensureDirs());

  it("writes one validated content-free receipt", () => {
    const threadId = "prompt-plan-writer-utf8";
    appendPromptPlan(threadId, { ...basePlan(), sections: [{ id: "memory", bytes: Buffer.byteLength("é", "utf8"), sent: true }] });
    const file = join(NATIVE_DIR, `${threadId}.ndjson`);
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.source).toBe("prompt.plan");
    expect(record.msg.sections).toEqual([{ id: "memory", bytes: 2, sent: true }]);
    expect(record.msg).not.toHaveProperty("text");
    expect(record.msg).not.toHaveProperty("cursor");
  });

  it("rejects malformed measurements and duplicate section ids", () => {
    const threadId = "prompt-plan-writer-invalid";
    appendPromptPlan(threadId, { ...basePlan(), systemSentBytes: -1 });
    appendPromptPlan(threadId, { ...basePlan(), sections: [
      { id: "memory", bytes: 4, sent: true },
      { id: "memory", bytes: 4, sent: false },
    ] });
    expect(existsSync(join(NATIVE_DIR, `${threadId}.ndjson`))).toBe(false);
  });
});
