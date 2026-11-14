import { describe, expect, it } from "vitest";
import {
  audienceIncludes, audienceMember, audienceRoom, baseBotId, isLayerId, layerAudience, layerId, mayRead, memberAudience, parseAudience,
  roomAudience, threadAudienceFrom, writesInto, type Audience,
} from "./audience.ts";

const ADA = "p_adaadaadaadaadaadaada1", BEN = "p_benbenbenbenbenbenben1";
const viewer = (person: string | null, rooms: string[] = [], admin = false) => ({ admin, person, seesRoom: (id: string) => rooms.includes(id) });

describe("the read rule", () => {
  const cases: Array<[Audience, Audience, boolean]> = [
    ["team", "team", true], ["team", roomAudience("r1"), true], ["team", memberAudience(ADA), true],
    [roomAudience("r1"), roomAudience("r1"), true], [roomAudience("r1"), roomAudience("r2"), false], [roomAudience("r1"), memberAudience(ADA), false], [roomAudience("r1"), "team", false],
    [memberAudience(ADA), memberAudience(ADA), true], [memberAudience(ADA), memberAudience(BEN), false], [memberAudience(ADA), roomAudience("r1"), false], [memberAudience(ADA), "team", false],
  ];
  it.each(cases)("a turn for %s may read %s: %s", (input, turn, allowed) => {
    expect(mayRead(input, turn)).toBe(allowed);
  });
  it("writes only into its own audience", () => {
    for (const turn of ["team", roomAudience("r1"), memberAudience(ADA)] as Audience[]) expect(writesInto(turn)).toBe(turn);
  });
});

describe("who an audience includes", () => {
  it("the team's: everyone; a room's: whoever sees the room, and the admins; a member's: that member only", () => {
    expect(audienceIncludes("team", viewer(null))).toBe(true);
    expect(audienceIncludes(roomAudience("r1"), viewer(ADA, ["r1"]))).toBe(true);
    expect(audienceIncludes(roomAudience("r1"), viewer(ADA, []))).toBe(false);
    expect(audienceIncludes(memberAudience(ADA), viewer(ADA))).toBe(true);
    expect(audienceIncludes(memberAudience(ADA), viewer(BEN))).toBe(false);
    expect(audienceIncludes(memberAudience(ADA), viewer(null))).toBe(false);
    expect(audienceIncludes(roomAudience("r1"), viewer(null, [], true))).toBe(true);
  });
  it("an Admin, the Owner included, never sees another person's private chat, only their own", () => {
    expect(audienceIncludes(memberAudience(ADA), viewer(BEN, [], true))).toBe(false);
    expect(audienceIncludes(memberAudience(ADA), viewer(null, [], true))).toBe(false);
    expect(audienceIncludes(memberAudience(BEN), viewer(BEN, [], true))).toBe(true);
    expect(audienceIncludes("team", viewer(BEN, [], true))).toBe(true);
  });
});

describe("a conversation's audience", () => {
  const markers = new Set(["p_nobodynobodynobodynob1", "p_outsideoutsideoutside1"]);
  it("is the room's in a room, the person's for a conversation they opened, and the team's for the main chat, nobody's or a marker's", () => {
    expect(threadAudienceFrom({ room: "r1", starter: ADA, markers })).toBe("room:r1");
    expect(threadAudienceFrom({ room: null, starter: ADA, markers })).toBe(`member:${ADA}`);
    expect(threadAudienceFrom({ room: undefined, starter: undefined, markers })).toBe("team");
    expect(threadAudienceFrom({ room: null, starter: "p_nobodynobodynobodynob1", markers })).toBe("team");
    expect(threadAudienceFrom({ room: null, starter: "p_outsideoutsideoutside1", markers })).toBe("team");
    expect(threadAudienceFrom({ room: null, starter: "not a key!", markers })).toBe("team");
  });
});

describe("memory layers", () => {
  it("the team's layer is the bot's own folder; a room's and a member's are sibling folders that name the bot", () => {
    expect(layerId("scout", "team")).toBe("scout");
    expect(layerId("scout", roomAudience("r1"))).toBe("scout--room-r1");
    expect(layerId("scout", memberAudience(ADA))).toBe(`scout--member-${ADA}`);
    for (const id of ["scout", "scout--room-r1", `scout--member-${ADA}`]) expect(baseBotId(id)).toBe("scout");
    expect(isLayerId("scout")).toBe(false);
    expect(isLayerId("scout--room-r1")).toBe(true);
    expect(layerAudience("scout")).toBe("team");
    expect(layerAudience("scout--room-r1")).toBe("room:r1");
    expect(layerAudience(`scout--member-${ADA}`)).toBe(`member:${ADA}`);
    // A layer id is a valid bot-shaped id, so every memory reader and writer takes it unchanged.
    expect(`scout--member-${ADA}`).toMatch(/^[\w-]+$/);
  });
  it("parses and takes apart what it made", () => {
    expect(parseAudience("team")).toBe("team");
    expect(parseAudience("room:r1")).toBe("room:r1");
    expect(parseAudience(`member:${ADA}`)).toBe(`member:${ADA}`);
    expect(parseAudience("room:")).toBeNull();
    expect(parseAudience("everyone")).toBeNull();
    expect(parseAudience(7)).toBeNull();
    expect(audienceRoom("room:r1")).toBe("r1");
    expect(audienceRoom("team")).toBeNull();
    expect(audienceMember(`member:${ADA}`)).toBe(ADA);
    expect(audienceMember("room:r1")).toBeNull();
  });
});
