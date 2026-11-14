import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCloudTeamHost } from "./cloud-team-host.ts";

function host(team: { id: string; name: string } | null) {
  const starters = new Map([["ada-chat", "p_ada"], ["cleo-chat", "p_cleo"], ["main-chat", "nobody"]]);
  return createCloudTeamHost({
    team, dataDir: mkdtempSync(join(tmpdir(), "omb-team-host-")),
    store: { groupByThread: (threadId) => (threadId === "room-chat" ? { id: "launch" } : undefined) },
    starters, markers: new Set(["nobody"]),
  });
}

describe("whose browser a conversation uses", () => {
  it("on a Team Cloud: the member's for her private chat, the group chat's, the team's for the bot's main chat", () => {
    const team = host({ id: "team-acme-1", name: "Acme" });
    expect(team.browserAudience("ada-chat")).toBe("member:p_ada");
    expect(team.browserAudience("cleo-chat")).toBe("member:p_cleo");
    expect(team.browserAudience("room-chat")).toBe("room:launch");
    expect(team.browserAudience("main-chat")).toBe("team");
  });

  it("elsewhere: always the bot's own, whoever opened the conversation", () => {
    const mine = host(null);
    for (const thread of ["ada-chat", "room-chat", "main-chat"]) expect(mine.browserAudience(thread)).toBe("team");
    expect(mine.viewerBrowserAudience({ threadId: "cleo-chat", sees: () => false, person: "p_ada" })).toBe("team");
  });
});

describe("whose browser a person's live view shows", () => {
  const team = host({ id: "team-acme-1", name: "Acme" });
  const sees = (visible: string[]) => (threadId: string) => visible.includes(threadId);

  it("the conversation's they look at, when they may read it; none for one hidden from them", () => {
    expect(team.viewerBrowserAudience({ threadId: "ada-chat", sees: sees(["ada-chat"]), person: "p_ada" })).toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: "ada-chat", sees: sees(["ada-chat", "cleo-chat"]), person: "p_ben" }), "an admin reading Ada's chat sees Ada's browser").toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: "cleo-chat", sees: sees(["ada-chat"]), person: "p_ada" })).toBeNull();
    expect(team.viewerBrowserAudience({ threadId: "room-chat", sees: sees(["room-chat"]), person: "p_cleo" })).toBe("room:launch");
  });

  it("their own with no conversation named (the phone's view), and the team's for a session that names no person", () => {
    expect(team.viewerBrowserAudience({ threadId: null, sees: () => false, person: "p_ada" })).toBe("member:p_ada");
    expect(team.viewerBrowserAudience({ threadId: null, sees: () => true, person: null })).toBe("team");
  });
});
