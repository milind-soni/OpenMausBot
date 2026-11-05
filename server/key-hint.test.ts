import { describe, expect, it } from "vitest";
import { keyHint, keyStatus, nestedKeyStatus, withoutKeyHints } from "./key-hint.ts";

describe("a saved key's hint", () => {
  it("is the last four characters of a key long enough to spare them, and nothing for a short one", () => {
    expect(keyHint("sk-proj-abcdefgh1234")).toEqual({ last4: "1234" });
    expect(keyHint("  sk-proj-abcdefgh1234\n")).toEqual({ last4: "1234" });
    expect(keyHint("short-key")).toEqual({});
    expect(keyStatus("")).toEqual({ configured: false });
    expect(keyStatus(undefined)).toEqual({ configured: false });
  });

  it("is given for every saved picture key, Gemini included", () => {
    const saved = nestedKeyStatus({ imageGen: { key: "openai-image-1111", customApiKey: "gateway-key-2222", geminiKey: "gemini-image-3333" } });
    expect([saved.openaiImageApiKey, saved.customImageApiKey, saved.geminiImageApiKey]).toEqual([
      { configured: true, last4: "1111" }, { configured: true, last4: "2222" }, { configured: true, last4: "3333" },
    ]);
  });

  it("comes off everything a client session is sent, at any depth", () => {
    const status = {
      openai: { configured: true, last4: "a1b2" },
      savedKeys: { ttsKey: { configured: true, last4: "c3d4" } },
      list: [{ configured: true, last4: "e5f6" }],
      vps: { configured: true, sshAlias: "host" },
    };
    expect(withoutKeyHints(status)).toEqual({
      openai: { configured: true },
      savedKeys: { ttsKey: { configured: true } },
      list: [{ configured: true }],
      vps: { configured: true, sshAlias: "host" },
    });
    expect(status.openai.last4).toBe("a1b2");
  });
});
