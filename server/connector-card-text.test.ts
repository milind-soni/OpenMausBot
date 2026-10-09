import { describe, expect, it } from "vitest";

import { connectorCardText } from "./connector-card-text.ts";

describe("connectorCardText", () => {
  it("names the app the bot is waiting on", () => {
    expect(connectorCardText("GitHub")).toBe("Connect GitHub to continue.");
  });

  it("names the account for a second-account card", () => {
    expect(connectorCardText("Gmail", "work")).toBe("Connect Gmail as “work” to continue.");
  });

  it("collapses stray whitespace and never prints an empty name", () => {
    expect(connectorCardText("  Google \n Calendar ", "  ")).toBe("Connect Google Calendar to continue.");
    expect(connectorCardText("   ")).toBe("Connect this app to continue.");
  });
});
