import { describe, expect, it } from "vitest";

import { geminiApprovalArgs } from "./gemini.ts";
import { qwenApprovalArgs } from "./qwen.ts";

describe("qwenApprovalArgs", () => {
  it("passes each level through as the CLI's own flag", () => {
    expect(qwenApprovalArgs(false, "ask")).toEqual([]);
    expect(qwenApprovalArgs(false, undefined)).toEqual([]);
    expect(qwenApprovalArgs(false, "edits")).toEqual(["--approval-mode", "auto-edit"]);
    expect(qwenApprovalArgs(false, "auto")).toEqual(["--approval-mode", "auto"]);
    expect(qwenApprovalArgs(true, "full")).toEqual(["--yolo"]);
    expect(qwenApprovalArgs(true, "ask")).toEqual(["--yolo"]);
    expect(qwenApprovalArgs(true, undefined)).toEqual(["--yolo"]);
  });
});

describe("geminiApprovalArgs", () => {
  it("passes Edits and Full through and leaves Auto as Ask (no reviewer)", () => {
    expect(geminiApprovalArgs(false, "ask")).toEqual([]);
    expect(geminiApprovalArgs(false, "auto")).toEqual([]);
    expect(geminiApprovalArgs(false, "edits")).toEqual(["--approval-mode", "auto_edit"]);
    expect(geminiApprovalArgs(true, "full")).toEqual(["--yolo"]);
  });
});
