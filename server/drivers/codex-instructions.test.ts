import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { syncCodexInstructions } from "./codex-instructions.ts";

describe("Codex instruction receipts", () => {
  it("does not repeat unchanged rules, but persists edits and removal", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "native", "old", false, request);
    await syncCodexInstructions(key, "native", "old", true, request);
    expect(request).not.toHaveBeenCalled();
    await syncCodexInstructions(key, "native", "new", true, request);
    await syncCodexInstructions(key, "native", "new", true, request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].items[0]).toMatchObject({ role: "developer" });
    expect(request.mock.calls[0][1].items[0].content[0].text).toContain("new");
    await syncCodexInstructions(key, "native", "", true, request);
    await syncCodexInstructions(key, "native", "", true, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].items[0].content[0].text).toContain("No OpenMausBot bot-specific instructions remain.");
  });

  it("adopts an existing native session once without replaying user history", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "pre-fix", "current rules", true, request);
    await syncCodexInstructions(key, "pre-fix", "current rules", true, request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("thread/inject_items");
    expect(request.mock.calls[0][1].threadId).toBe("pre-fix");
    expect(request.mock.calls[0][1].items).toHaveLength(1);
  });

  it("does not acknowledge an update that Codex rejected", async () => {
    const key = randomUUID();
    const rejected = vi.fn().mockRejectedValue(new Error("method not found"));
    await expect(syncCodexInstructions(key, "native", "rules", true, rejected)).rejects.toThrow("method not found");
    const accepted = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "native", "rules", true, accepted);
    await syncCodexInstructions(key, "native", "rules", true, accepted);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("keeps native sessions independent even for one OpenMausBot task", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "first", "rules", false, request);
    await syncCodexInstructions(key, "second", "rules", true, request);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
