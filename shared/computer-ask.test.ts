import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  cleanAskWhy, COMPUTER_ASK_REASONS, COMPUTER_ASK_WORDS, computerAskReasonLine, computerAskText, needsTheApp, turnsOnFromHere,
} from "./computer-ask.ts";

const line = (reason: (typeof COMPUTER_ASK_REASONS)[number], device: "PC" | "Mac" | "computer") => {
  const { key, params } = computerAskReasonLine({ reason, device }, "Scout");
  return computerAskText(key, params);
};

describe("a bot's ask to turn on what it needs from the person's computer", () => {
  it("says plainly why it isn't available, in the person's words for their computer", () => {
    expect(line("paused", "PC")).toBe("Using your PC is paused.");
    expect(line("not-running", "PC")).toBe("Screen control isn't running on your PC.");
    expect(line("blocked", "PC")).toBe("Screen control is blocked on your PC: Windows Security may have stopped it.");
    expect(line("blocked", "Mac")).toBe("Screen control is blocked on your Mac.");
    expect(line("permissions", "Mac")).toBe("macOS hasn't allowed MausBot to see and use the screen yet.");
    expect(line("closed", "PC")).toBe("MausBot isn't open on your PC. Open it there and Scout carries on.");
    expect(line("never", "computer")).toBe("MausBot isn't on your computer yet. Install it, sign in to MausBot Cloud there, and Scout carries on.");
    expect(line("update", "PC")).toBe("MausBot on your PC needs an update first. Update it, and Scout carries on.");
  });

  it("offers Turn on only where the app on that computer can do it, and the app itself where it's the fix", () => {
    expect(COMPUTER_ASK_REASONS.filter(turnsOnFromHere)).toEqual(["paused", "permissions", "blocked", "off", "not-running", "terminal-off"]);
    expect(COMPUTER_ASK_REASONS.filter(needsTheApp)).toEqual(["closed", "never", "update"]);
    expect(COMPUTER_ASK_REASONS.filter((reason) => !turnsOnFromHere(reason) && !needsTheApp(reason))).toEqual(["starting", "unsupported"]);
  });

  it("keeps a bot's reason to one clean line on the card", () => {
    expect(cleanAskWhy("  Fill in\nthe invoice‮ in Excel  ")).toBe("Fill in the invoice in Excel");
    expect(cleanAskWhy("x".repeat(300))).toHaveLength(200);
    expect(cleanAskWhy("   ")).toBeUndefined();
    expect(cleanAskWhy(42)).toBeUndefined();
  });

  it("matches the words the app shows, key for key", () => {
    for (const [key, text] of Object.entries(COMPUTER_ASK_WORDS)) expect((en as Record<string, string>)[key], key).toBe(text);
  });
});
