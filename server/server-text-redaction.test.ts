import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { failedNoticeTool, noticeTool } from "./chat-notices.ts";
import { DATA_DIR } from "./config.ts";
import { claudeLimitError } from "./drivers/claude-limits.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const SECRET = `sk-ant-${"a1B2".repeat(8)}`;

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("a notice's params are scrubbed like its English", () => {
  it("in everything the store keeps", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const limit = claudeLimitError({ window: "five_hour" } as never, `use ${SECRET} instead`, 0, "UTC");
    expect(JSON.stringify(limit)).not.toContain(SECRET);
    const failed = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { ...failedNoticeTool("chat.notice.stalled", { minutes: 20 }), name: `error: ${limit.message}`, nameCode: limit.text!.key, nameParams: limit.text!.params } });
    const webhook = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `my webhook "${SECRET}"`, textCode: "chat.notice.webhookHome", textParams: { name: SECRET } });
    const held = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: noticeTool("chat.notice.goalWaiting", { name: SECRET }, { ok: false }) });
    const resumed = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: noticeTool("chat.notice.cutOffByRestart", { name: `Scout, ${SECRET}` }, { ok: true }) });
    expect(resumed.tool?.nameCode).toBe("chat.notice.cutOffByRestart");
    for (const kept of [...store.messagesFor(bot.threadId), failed, webhook, held, resumed]) expect(JSON.stringify(kept)).not.toContain(SECRET);
  });
});
