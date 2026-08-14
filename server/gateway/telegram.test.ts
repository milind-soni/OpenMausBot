import { describe, expect, it } from "vitest";

import { askHeader, chunkText, keyboardFor, TELEGRAM_MAX } from "./telegram.ts";

describe("chunkText", () => {
  it("returns short text as a single chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("splits at the telegram limit", () => {
    const text = "a".repeat(TELEGRAM_MAX + 10);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(TELEGRAM_MAX);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers newline boundaries when one is close enough", () => {
    const first = "x".repeat(3000);
    const text = `${first}\n${"y".repeat(2000)}`;
    const chunks = chunkText(text);
    expect(chunks[0]).toBe(first);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-cuts when the only newline would waste half the budget", () => {
    const text = `ab\n${"z".repeat(TELEGRAM_MAX * 2)}`;
    const chunks = chunkText(text);
    expect(chunks[0]).toHaveLength(TELEGRAM_MAX);
    expect(chunks.join("")).toBe(text);
  });
});

describe("keyboardFor", () => {
  it("gives permissions Allow/Deny wired to the requestId", () => {
    const kb = keyboardFor({ requestId: "r1", requestType: "permission", tool: "shell", summary: "rm -rf /tmp/x" });
    expect(kb).toEqual([[
      { text: "✅ Allow", callback_data: "req:r1:allow" },
      { text: "❌ Deny", callback_data: "req:r1:deny" },
    ]]);
  });

  it("gives questions one button per choice, capped at 5", () => {
    const kb = keyboardFor({
      requestId: "r2",
      requestType: "question",
      tool: "ask_user",
      summary: "Which color?",
      choices: ["red", "green", "blue", "black", "white", "extra"],
    });
    expect(kb).toHaveLength(5);
    expect(kb[0][0]).toEqual({ text: "red", callback_data: "req:r2:choice:0" });
  });

  it("offers a free-text prompt when a question has no choices", () => {
    const kb = keyboardFor({ requestId: "r3", requestType: "question", tool: "ask_user", summary: "Anything?" });
    expect(kb[0][0].callback_data).toBe("req:r3:prompt");
  });
});

describe("askHeader", () => {
  it("names the bot and the tool for permissions", () => {
    const line = askHeader("Pixel", { requestId: "r", requestType: "permission", tool: "shell", summary: "git push" });
    expect(line).toContain("Pixel");
    expect(line).toContain("shell");
    expect(line).toContain("git push");
  });
});
