import { describe, expect, it } from "vitest";

import { connectorCardDescription, connectorCardText, signInCardText } from "./connector-card-text.ts";
import "./server-line-packs.ts";

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

  it("says it in the language of the person the card is for", () => {
    expect(connectorCardText("Microsoft Clarity", undefined, "de")).toBe("Verbinde Microsoft Clarity, um fortzufahren.");
    expect(connectorCardText("Gmail", "Arbeit", "de")).toBe("Verbinde Gmail als „Arbeit“, um fortzufahren.");
    expect(connectorCardText("   ", undefined, "de")).toBe("Verbinde diese App, um fortzufahren.");
    expect(connectorCardDescription("Notion", undefined, "de")).toBe("Verbinde Notion, damit der Bot weitermachen kann");
    expect(connectorCardDescription("Notion", undefined, undefined)).toBe("Connect Notion so the bot can continue");
    expect(signInCardText("Biber", "github.com", "de"))
      .toBe("Biber braucht deine Anmeldung bei github.com. Öffne diese Unterhaltung in OpenMausBot, melde dich an und bestätige es dann auf der Karte.");
    expect(signInCardText("Biber", "github.com")).toBe("Biber needs you to sign in to github.com. Open this conversation in OpenMausBot to sign in, then press Done.");
  });
});
