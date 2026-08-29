import { describe, expect, it } from "vitest";

import {
  editableUrl,
  profileIdFor,
  shouldRequestBrowserControl,
} from "./BrowserPanel";

describe("browser panel address and profile helpers", () => {
  it("keeps the complete URL that will be submitted", () => {
    const url = "https://example.com/path/to/page?account=work&tab=2#details";
    expect(editableUrl(url)).toBe(url);
    expect(editableUrl("about:blank")).toBe("");
  });

  it("creates partition-safe, collision-free profile ids", () => {
    const profiles = [
      { id: "work-microsoft", name: "Work Microsoft" },
      { id: "work-microsoft-2", name: "Work Microsoft 2" },
    ];
    expect(profileIdFor(" Work / Microsoft ", profiles)).toBe("work-microsoft-3");
    expect(profileIdFor("🔥", profiles)).toBe("profile");
  });

  it("coalesces native focus and input into one take-control request", () => {
    const first = {
      botId: "bot-1",
      eventBotId: "bot-1",
      held: false,
      pending: false,
      takeInFlight: false,
    };
    expect(shouldRequestBrowserControl(first)).toBe(true);
    expect(shouldRequestBrowserControl({ ...first, takeInFlight: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, pending: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, held: true })).toBe(false);
    expect(shouldRequestBrowserControl({ ...first, eventBotId: "bot-2" })).toBe(false);
  });
});
