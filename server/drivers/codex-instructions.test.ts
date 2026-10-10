import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./codex-instructions.ts";

const receiptPath = (key: string, nativeThreadId: string) =>
  join(DATA_DIR, "codex-instructions", `${createHash("sha256").update(JSON.stringify([key, nativeThreadId])).digest("hex")}.sha256`);

describe("Codex effective developer instructions", () => {
  it("preserves native rules after bot rules, including when bot rules are removed", () => {
    const config = { developer_instructions: "Native rules." };
    expect(codexDeveloperInstructions(config, "Bot rules.")).toBe("Bot rules.\n\nNative rules.");
    expect(codexDeveloperInstructions(config, "")).toBe("No OpenMausBot bot-specific instructions remain.\n\nNative rules.");
    expect(codexDeveloperInstructions({}, "Bot rules.")).toBe("Bot rules.");
    expect(codexDeveloperInstructions({ developer_instructions: null }, "")).toBe("");
  });

  it.each([undefined, null, [], { developer_instructions: 42 }])("rejects unknown native configuration: %j", (config) => {
    expect(() => codexDeveloperInstructions(config, "Bot rules.")).toThrow("cannot safely update bot instructions");
  });
});

describe("Codex instruction receipts", () => {
  it("does not repeat unchanged rules, but persists edits and removal", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "native", "old", "", false, request);
    await syncCodexInstructions(key, "native", "old", "", true, request);
    expect(request).not.toHaveBeenCalled();
    await syncCodexInstructions(key, "native", "new", "", true, request);
    await syncCodexInstructions(key, "native", "new", "", true, request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].items[0]).toMatchObject({ role: "developer" });
    expect(request.mock.calls[0][1].items[0].content[0].text).toContain("new");
    await syncCodexInstructions(key, "native", "", "", true, request);
    await syncCodexInstructions(key, "native", "", "", true, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].items[0].content[0].text).toContain("No OpenMausBot bot-specific instructions remain.");
  });

  it("adopts an existing native session once without replaying user history", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "pre-fix", "current rules", "", true, request);
    await syncCodexInstructions(key, "pre-fix", "current rules", "", true, request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("thread/inject_items");
    expect(request.mock.calls[0][1].threadId).toBe("pre-fix");
    expect(request.mock.calls[0][1].items).toHaveLength(1);
  });

  it("does not acknowledge an update that Codex rejected", async () => {
    const key = randomUUID();
    const rejected = vi.fn().mockRejectedValue(new Error("method not found"));
    await expect(syncCodexInstructions(key, "native", "rules", "", true, rejected)).rejects.toThrow("method not found");
    const accepted = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "native", "rules", "", true, accepted);
    await syncCodexInstructions(key, "native", "rules", "", true, accepted);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("keeps native sessions independent even for one OpenMausBot task", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "first", "rules", "", false, request);
    await syncCodexInstructions(key, "second", "rules", "", true, request);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("delivers a changed volatile half without touching developer rules", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    const first = await syncCodexInstructions(key, "native", "rules", "memory v1", false, request);
    first.commitVolatile?.();
    expect(first).toMatchObject({ deliverVolatile: true, hadVolatile: false });
    const unchanged = await syncCodexInstructions(key, "native", "rules", "memory v1", true, request);
    expect(unchanged).toMatchObject({ deliverVolatile: false, hadVolatile: true });
    const changed = await syncCodexInstructions(key, "native", "rules", "memory v2", true, request);
    changed.commitVolatile?.();
    expect(changed).toMatchObject({ deliverVolatile: true, hadVolatile: true });
    expect(request).not.toHaveBeenCalled();
    const cleared = await syncCodexInstructions(key, "native", "rules", "", true, request);
    cleared.commitVolatile?.();
    expect(cleared).toMatchObject({ deliverVolatile: true, hadVolatile: true });
  });

  it("treats a legacy bare-fingerprint receipt as unknown volatile context", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    await syncCodexInstructions(key, "native", "rules", "", false, request);
    // A receipt written before the split carries only the instruction digest.
    const path = receiptPath(key, "native");
    const fingerprint = JSON.parse(readFileSync(path, "utf8")).instructions;
    writeFileSync(path, fingerprint, { mode: 0o600 });
    const legacy = await syncCodexInstructions(key, "native", "rules", "memory v1", true, request);
    expect(legacy).toMatchObject({ deliverVolatile: true, hadVolatile: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("delivers mention context on every tagged turn even when the volatile half is unchanged", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    const first = await syncCodexInstructions(key, "native", "rules", "Tagged: @Testy", false, request);
    first.commitVolatile?.();
    const untagged = await syncCodexInstructions(key, "native", "rules", "Tagged: @Testy", true, request);
    expect(untagged.deliverVolatile).toBe(false);
    const tagged = await syncCodexInstructions(key, "native", "rules", "Tagged: @Testy", true, request, true);
    expect(tagged.deliverVolatile).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the volatile digest pending until the provider accepts the turn", async () => {
    const key = randomUUID();
    const request = vi.fn().mockResolvedValue({});
    const first = await syncCodexInstructions(key, "native", "rules", "memory v1", true, request);
    expect(first.deliverVolatile).toBe(true);
    // the on-disk receipt does not yet claim the volatile half was carried
    const path = receiptPath(key, "native");
    const pending = JSON.parse(readFileSync(path, "utf8"));
    expect(pending).toEqual({ instructions: expect.any(String) });
    // so a retry before acceptance still redelivers it
    const retry = await syncCodexInstructions(key, "native", "rules", "memory v1", true, request);
    expect(retry.deliverVolatile).toBe(true);
    expect(first.commitVolatile).toBeTypeOf("function");
    first.commitVolatile?.();
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual({ instructions: pending.instructions, volatile: expect.any(String) });
    const after = await syncCodexInstructions(key, "native", "rules", "memory v1", true, request);
    expect(after.deliverVolatile).toBe(false);
    expect(after.commitVolatile).toBeNull();
  });
});
