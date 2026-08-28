// Bounding what a harness-owned MCP server hands back to an agent.
//
// The thing being pinned down is the trade: a caller must never lose the
// beginning of an output, must always be TOLD when the rest was dropped, and
// must be able to go get it when the bot has somewhere to read it from.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_SPILL_FILE_BYTES,
  SPILL_HEAD_BYTES,
  SPILL_THRESHOLD_BYTES,
  boundToolText,
} from "./tool-output.ts";
import { workspaceDir } from "./workspace.ts";

describe("boundToolText", () => {
  it("returns short output untouched", () => {
    expect(boundToolText("all good")).toBe("all good");
  });

  it("keeps a head slice and says how much was dropped when there is no workspace", () => {
    const big = "x".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big);
    expect(bounded.length).toBeLessThan(SPILL_HEAD_BYTES + 500);
    expect(bounded.startsWith("x".repeat(100))).toBe(true);
    expect(bounded).toContain("truncated");
    expect(bounded).toContain(String(big.length));
    expect(bounded).not.toContain(".txt");
  });
});

describe("boundToolText with a workspace", () => {
  const spillDir = (botId: string) => join(workspaceDir(botId), ".maus", "tool-output");

  it("writes the full text to the bot workspace and names the path", () => {
    const big = "y".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big, { botId: "bot-1", label: "computer_exec" });
    const files = readdirSync(spillDir("bot-1"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(spillDir("bot-1"), files[0]!), "utf8")).toBe(big);
    expect(bounded).toContain(files[0]!);
    expect(bounded).toContain("computer_exec");
    // the head still survives — spilling is not an excuse to hand back a pointer
    expect(bounded.startsWith("y".repeat(100))).toBe(true);
  });

  it("caps what it writes to disk", () => {
    const huge = "z".repeat(MAX_SPILL_FILE_BYTES + 10_000);
    boundToolText(huge, { botId: "bot-2" });
    const written = readFileSync(join(spillDir("bot-2"), readdirSync(spillDir("bot-2"))[0]!), "utf8");
    expect(Buffer.byteLength(written, "utf8")).toBe(MAX_SPILL_FILE_BYTES);
  });

  it("falls back to the truncation note when the spill cannot be written", () => {
    // a bot id that is not a usable directory name is the cheapest way to
    // force the write to fail; the tool call must still return its output
    const big = "q".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big, { botId: "\0bad" });
    expect(bounded).toContain("truncated");
    expect(bounded).not.toContain(".txt");
  });
});
