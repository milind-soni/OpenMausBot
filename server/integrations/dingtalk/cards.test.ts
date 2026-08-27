import { describe, expect, it } from "vitest";

import { renderDingTalkOwnerStatusCard } from "./cards.ts";

describe("DingTalk Owner status card", () => {
  it("carries only per-action opaque values and no client-side privilege claims", () => {
    const card = renderDingTalkOwnerStatusCard({
      cardTemplateId: "template-1",
      outTrackId: "out-track-1",
      title: "等待 Owner 决策",
      workItemId: "WI-1",
      status: "paused",
      summary: "候选已保留",
      actions: [{ label: "恢复", actionToken: "opaque-token" }],
    });
    expect(card).toMatchObject({ cardTemplateId: "template-1", outTrackId: "out-track-1", callbackType: "STREAM" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("opaque-token");
    expect(serialized).not.toContain("administrator");
    expect(serialized).not.toContain("requiredRole");
    expect(serialized).not.toContain("expectedVersion");
  });
});
