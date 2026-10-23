import { describe, expect, it } from "vitest";

import { hiddenFromSidebar, myDefaultBot, setupSteps, someoneElsesDefaultBot } from "./default-bot";
import { partitionSidebarBots } from "./sidebar-layout";
import type { DefaultBotFields } from "../../shared/default-bot";

const bot = (id: string, fields: DefaultBotFields = {}): DefaultBotFields & { id: string } => ({ id, ...fields });

describe("MausBot in the sidebar", () => {
  it("leaves out a MausBot whose Show switch is off, and on a Team Cloud other people's, but keeps the viewer's own", () => {
    const bots = [
      bot("maus", { defaultBot: {} }),
      bot("ada-maus", { defaultBot: { person: "ada@example.com" } }),
      bot("bea-maus", { defaultBot: { person: "bea@example.com" } }),
      bot("writer"),
    ];
    const shown = (viewerEmail: string | null) => partitionSidebarBots(bots, { viewerEmail }).unsectionedBots.map((entry) => entry.id);
    expect(shown("ada@example.com")).toEqual(["maus", "ada-maus", "writer"]);
    expect(shown(null)).toEqual(["maus", "writer"]);
    bots[0] = bot("maus", { defaultBot: {}, sidebarHidden: true });
    expect(shown(null)).toEqual(["writer"]);
    expect(hiddenFromSidebar(bots[0]!, null)).toBe(true);
    expect(someoneElsesDefaultBot(bots[2]!, "ADA@example.com".toLowerCase())).toBe(true);
  });

  it("finds the viewer's own MausBot: their own on a team, the place's otherwise, none until the viewer is known", () => {
    const team = [bot("ada-maus", { defaultBot: { person: "ada@example.com" } }), bot("writer")];
    expect(myDefaultBot(team, undefined)).toBeUndefined();
    expect(myDefaultBot(team, "ada@example.com")?.id).toBe("ada-maus");
    expect(myDefaultBot(team, "bea@example.com")).toBeUndefined();
    const place = [bot("writer"), bot("maus", { defaultBot: {} })];
    expect(myDefaultBot(place, null)?.id).toBe("maus");
    expect(myDefaultBot(place, "owner@example.com")?.id).toBe("maus");
  });
});

describe("MausBot's identity is its mark, never its name", () => {
  it("keeps finding a renamed MausBot for the Settings switch and the sidebar, and keeps it out of the list while its welcome is open", () => {
    const bots = [bot("writer"), { ...bot("maus", { defaultBot: {} }), name: "Jarvis" }];
    expect(myDefaultBot(bots, null)?.id).toBe("maus");
    expect(partitionSidebarBots(bots, { viewerEmail: null }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer", "maus"]);
    expect(partitionSidebarBots(bots, { viewerEmail: null, welcoming: "maus" }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer"]);
  });
});

describe("what MausBot offers to set up", () => {
  const fresh = { aiReady: false, ownBots: 0, onCloud: false, team: false, remote: false };

  it("on a fresh install, only the steps still to do", () => {
    expect(setupSteps(fresh)).toEqual(["ai", "bots", "apps", "phone", "cloud"]);
    expect(setupSteps({ ...fresh, aiReady: true })).toEqual(["bots", "apps", "phone"].concat("cloud"));
    expect(setupSteps({ ...fresh, aiReady: true, onCloud: true })).toEqual(["bots", "apps", "phone"]);
  });

  it("never nags a person who is set up, nor a Team Cloud member", () => {
    expect(setupSteps({ ...fresh, aiReady: true, ownBots: 3 })).toEqual([]);
    expect(setupSteps({ ...fresh, ownBots: 3 })).toEqual(["ai"]);
    expect(setupSteps({ ...fresh, team: true })).toEqual([]);
  });
});
