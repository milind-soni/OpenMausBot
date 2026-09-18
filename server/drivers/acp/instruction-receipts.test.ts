import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";
import {
  acpInstructionReceiptPath,
  acpInstructionSectionHash,
  readAcpInstructionReceipt,
  writeAcpInstructionReceipt,
} from "./instruction-receipts.ts";

const sections = [{ id: "memory", label: "Memory", text: "private prompt text", bytes: 19 }];

describe("ACP instruction receipts", () => {
  it("stores only ordered section hashes with restrictive permissions", () => {
    const path = acpInstructionReceiptPath("receipt-provider", "receipt-bot", "receipt-thread", "receipt-session");
    writeAcpInstructionReceipt("receipt-provider", "receipt-bot", "receipt-thread", "receipt-session", sections);
    expect(readAcpInstructionReceipt("receipt-provider", "receipt-bot", "receipt-thread", "receipt-session")).toEqual({
      version: 1,
      sections: [{ id: "memory", hash: acpInstructionSectionHash("private prompt text") }],
    });
    expect(readFileSync(path, "utf8")).not.toContain("private prompt text");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["malformed", "not json"],
    ["wrong version", JSON.stringify({ version: 2, sections: [] })],
    ["invalid hash", JSON.stringify({ version: 1, sections: [{ id: "memory", hash: "nope" }] })],
    ["duplicate ids", JSON.stringify({ version: 1, sections: [
      { id: "memory", hash: "a".repeat(64) },
      { id: "memory", hash: "b".repeat(64) },
    ] })],
  ])("treats %s as an unknown receipt", (_name, value) => {
    const path = acpInstructionReceiptPath("receipt-provider-invalid", "receipt-bot", "receipt-thread", _name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    expect(readAcpInstructionReceipt("receipt-provider-invalid", "receipt-bot", "receipt-thread", _name)).toBeUndefined();
  });

  it("keys receipts by provider, bot, thread, and native session", () => {
    const base = acpInstructionReceiptPath("provider-a", "bot-a", "thread-a", "session-a");
    expect(acpInstructionReceiptPath("provider-b", "bot-a", "thread-a", "session-a")).not.toBe(base);
    expect(acpInstructionReceiptPath("provider-a", "bot-b", "thread-a", "session-a")).not.toBe(base);
    expect(acpInstructionReceiptPath("provider-a", "bot-a", "thread-b", "session-a")).not.toBe(base);
    expect(acpInstructionReceiptPath("provider-a", "bot-a", "thread-a", "session-b")).not.toBe(base);
  });
});
