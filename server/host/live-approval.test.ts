import { expect, it } from "vitest";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import type { BotRecord } from "../store.ts";
import { createLiveApprovalMode, type LiveApprovalDeps } from "./live-approval.ts";

const running = { id: "ada", threadId: "t1", approvalMode: "ask", modelSelection: { instanceId: "openaiCompat", model: "m" } } as unknown as BotRecord;

function live(saved: Partial<BotRecord> | null) {
  const seen: Array<{ bot: BotRecord; peer: boolean; threadId: string }> = [];
  const store = { projectBotForTask: () => saved && { ...running, ...saved } } as unknown as LiveApprovalDeps["store"];
  const level = createLiveApprovalMode({ store, turnLevel: (bot, peer, threadId) => { seen.push({ bot, peer, threadId }); return approvalModeFor(bot); } });
  return { level: (peer = false) => level(running, "t1", peer), seen };
}

it("reads the level saved now, never the copy the turn started with", () => {
  expect(live({ approvalMode: "full" }).level()).toBe("full");
  expect(live({ approvalMode: "ask" }).level()).toBe("ask");
  expect(live(null).level()).toBe("ask");
});

it("judges the saved level on the engine the turn runs, and passes the turn's origin through", () => {
  const w = live({ approvalMode: "full", modelSelection: { instanceId: "codex", model: "x" } });
  w.level(true);
  expect(w.seen).toEqual([{ bot: expect.objectContaining({ approvalMode: "full", modelSelection: running.modelSelection }), peer: true, threadId: "t1" }]);
});
