import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillRequestPreview } from "./SkillRequestPreview";
import type { SkillRequestCardData } from "../../shared/skill-request";

const request = (extra: Partial<SkillRequestCardData> = {}): SkillRequestCardData => ({
  version: 1,
  requestId: "request",
  botId: "bot",
  threadId: "thread",
  stagedId: "staged",
  action: "update",
  name: "expense-rules",
  gist: "Moves rules out",
  source: "learn:conversation",
  preview: "---\nname: expense-rules\n---\n\nFor edge cases, read references/edge-cases.md.\n",
  sha256: "a".repeat(64),
  warnings: [],
  createdAt: 0,
  ...extra,
});

describe("SkillRequestPreview", () => {
  it("shows every reference file in full beside SKILL.md", () => {
    const html = renderToStaticMarkup(createElement(SkillRequestPreview, {
      request: request({
        references: [{ path: "references/edge-cases.md", content: "# Edge cases\n\n- Receipts over 50 need a manager." }],
        referencesSha256: "b".repeat(64),
      }),
    }));
    expect(html).toContain("Review the complete SKILL.md and its reference files");
    expect(html).toContain("references/edge-cases.md");
    expect(html).toContain("Receipts over 50 need a manager.");
  });

  it("keeps the SKILL.md-only card unchanged", () => {
    const html = renderToStaticMarkup(createElement(SkillRequestPreview, { request: request() }));
    expect(html).toContain("Review the complete SKILL.md before");
    expect(html).not.toContain("reference files");
  });
});
