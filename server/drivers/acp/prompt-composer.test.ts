import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../../contracts.ts";
import { writeAcpInstructionReceipt } from "./instruction-receipts.ts";
import { composeAcpPrompt } from "./prompt-composer.ts";

const sections = [
  { id: "identity", label: "Identity", text: "IDENTITY", bytes: 8 },
  { id: "memory", label: "Memory", text: "MEMORY", bytes: 6 },
];

function turn(overrides: Partial<SendTurnInput> = {}): SendTurnInput {
  return {
    threadId: "composer-thread",
    botId: "composer-bot",
    text: "current turn",
    system: "IDENTITYMEMORY",
    systemSections: sections,
    ...overrides,
  };
}

describe("composeAcpPrompt", () => {
  it("keeps a fresh prompt byte-compatible with the old ACP composition", () => {
    expect(composeAcpPrompt({
      turn: turn(),
      providerInstanceId: "composer-provider",
      nativeSessionId: "composer-session",
      resumed: false,
    })).toMatchObject({
      mode: "fresh",
      text: "IDENTITYMEMORY\n\ncurrent turn",
    });
  });

  it("sends no system sections when a matching receipt is resumed", () => {
    writeAcpInstructionReceipt("composer-provider", "composer-bot", "composer-thread", "matching-session", sections);
    expect(composeAcpPrompt({
      turn: turn(),
      providerInstanceId: "composer-provider",
      nativeSessionId: "matching-session",
      resumed: true,
    })).toMatchObject({ mode: "resume", text: "current turn" });
  });

  it("sends changed sections and names removed ids", () => {
    const previous = [
      ...sections,
      { id: "old", label: "Old", text: "OLD", bytes: 3 },
    ];
    writeAcpInstructionReceipt("composer-provider", "composer-bot", "composer-thread", "changed-session", previous);
    const result = composeAcpPrompt({
      turn: turn({
        system: "IDENTITYMEMORY-2",
        systemSections: [sections[0]!, { ...sections[1]!, text: "MEMORY-2", bytes: 8 }],
      }),
      providerInstanceId: "composer-provider",
      nativeSessionId: "changed-session",
      resumed: true,
    });
    expect(result.text).toContain("Section \"memory\"");
    expect(result.text).toContain("MEMORY-2");
    expect(result.text).toContain('Removed section ids: "old".');
    expect(result.text).not.toContain("IDENTITY");
  });

  it("replaces an adopted session completely when its receipt is missing", () => {
    const result = composeAcpPrompt({
      turn: turn(),
      providerInstanceId: "composer-provider",
      nativeSessionId: "missing-session",
      resumed: true,
    });
    expect(result.mode).toBe("replacement");
    expect(result.text).toContain("complete block below replaces");
    expect(result.text).toContain("IDENTITYMEMORY");
    expect(result.text).toContain("current turn");
  });

  it("keeps a rejected resume's recovery text in the complete fresh prompt", () => {
    expect(composeAcpPrompt({
      turn: turn({ text: "recovered history\n\ncurrent turn" }),
      providerInstanceId: "composer-provider",
      nativeSessionId: "recovery-session",
      resumed: false,
      resumeRejected: true,
    })).toMatchObject({
      mode: "recovery",
      text: "IDENTITYMEMORY\n\nrecovered history\n\ncurrent turn",
    });
  });
});
