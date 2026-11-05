import { describe, expect, it } from "vitest";
import { everyoneChief, mapDelivery, mapMessageTargets, sentToSummary } from "./map-composer";

const bots = [
  { id: "maya", name: "Maya Chen", section: "Research" },
  { id: "theo", name: "Theo", section: "Research" },
  { id: "theodora", name: "Theodora", section: "Design" },
  { id: "nora", name: "Nora Lind", section: "Design" },
  { id: "ghost", name: "Ghost", section: "Design", hidden: true },
  { id: "solo", name: "Solo" },
];
const teams = [{ key: "Research", name: "Research" }, { key: "Design", name: "Design" }, { key: "", name: "General" }];

describe("Team map message targets", () => {
  it("sends to each tagged bot once, in the order tagged, by its full name", () => {
    const result = mapMessageTargets("@Nora Lind and @maya chen, then @Nora Lind again", bots, teams);
    expect(result.botIds).toEqual(["nora", "maya"]);
    expect(result.tags.map((tag) => tag.kind)).toEqual(["bot", "bot", "bot"]);
  });

  it("prefers the longest name and never matches the start of a longer word", () => {
    expect(mapMessageTargets("@Theodora please", bots, teams).botIds).toEqual(["theodora"]);
    expect(mapMessageTargets("@Theo please", bots, teams).botIds).toEqual(["theo"]);
    expect(mapMessageTargets("@Theox please", bots, teams)).toMatchObject({ botIds: [], unknown: ["Theox"] });
  });

  it("expands a team to its visible bots and everyone to every visible bot", () => {
    expect(mapMessageTargets("@Design start", bots, teams).botIds).toEqual(["theodora", "nora"]);
    expect(mapMessageTargets("@General hello", bots, teams).botIds).toEqual(["solo"]);
    expect(mapMessageTargets("@everyone start your task", bots, teams).botIds).toEqual(["maya", "theo", "theodora", "nora", "solo"]);
    expect(mapMessageTargets("@Research and @theo", bots, teams).botIds).toEqual(["maya", "theo"]);
  });

  it("ignores hidden bots, unknown names, e-mail addresses and paths", () => {
    const result = mapMessageTargets("@Ghost @Bob mail me@example.com or see /a/@Theo", bots, teams);
    expect(result.botIds).toEqual([]);
    expect(result.unknown).toEqual(["Ghost", "Bob"]);
  });

  it("finds nobody in a message without a tag", () => {
    expect(mapMessageTargets("start your task", bots, teams)).toEqual({ botIds: [], tags: [], unknown: [], words: "start your task" });
  });

  it("summarises who a message went to", () => {
    expect(sentToSummary(["Ana"])).toEqual({ names: ["Ana"], more: 0 });
    expect(sentToSummary(["Ana", "Ben", "Cy"])).toEqual({ names: ["Ana", "Ben", "Cy"], more: 0 });
    expect(sentToSummary(["Ana", "Ben", "Cy", "Dee", "Eve"])).toEqual({ names: ["Ana", "Ben"], more: 3 });
  });
});

describe("Team map delivery", () => {
  const team = [
    { id: "chief", name: "Clive", chiefOfStaff: true },
    { id: "design-chief", name: "Dana", section: "Design", chiefOfStaff: true },
    ...bots,
  ];
  const targets = (text: string, roster = team) => mapMessageTargets(text, roster, teams);

  it("sends @everyone to the team's Chief alone, which passes it on", () => {
    expect(mapDelivery(targets("@everyone we need mail today"), team, false)).toEqual({ botIds: ["chief"], chief: team[0] });
  });

  it("still sends to a bot or team named directly, after the Chief", () => {
    expect(mapDelivery(targets("@everyone mail, and @Nora Lind check the inbox"), team, false).botIds).toEqual(["chief", "nora"]);
    expect(mapDelivery(targets("@Research @everyone status?"), team, false).botIds).toEqual(["chief", "maya", "theo"]);
  });

  it("sends a stop to every bot, as its own words, so each bot stops at once", () => {
    const stop = mapDelivery(targets("@everyone   stop now"), team, true);
    expect(stop.botIds).toEqual(targets("@everyone").botIds);
    expect(stop.text).toBe("stop now");
    expect(stop.chief).toBeUndefined();
  });

  it("sends to everyone as before when there is no Chief, and leaves lines without @everyone alone", () => {
    expect(mapDelivery(targets("@everyone hello", bots), bots, false)).toEqual({ botIds: ["maya", "theo", "theodora", "nora", "solo"] });
    expect(mapDelivery(targets("@Design start"), team, false)).toEqual({ botIds: ["design-chief", "theodora", "nora"] });
    expect(mapDelivery(targets("@Theo stop"), team, true)).toEqual({ botIds: ["theo"] });
  });

  it("prefers the Chief over the whole team to a department's, and never a hidden one", () => {
    expect(everyoneChief(team)?.id).toBe("chief");
    expect(everyoneChief(team.slice(1))?.id).toBe("design-chief");
    expect(everyoneChief([{ id: "x", name: "X", chiefOfStaff: true, hidden: true }, ...bots])).toBeUndefined();
  });

  it("takes only the tags out of the words", () => {
    expect(targets("@everyone alles stoppen").words).toBe("alles stoppen");
    expect(targets("Bitte @Theo und @Design: stop").words).toBe("Bitte und : stop");
    expect(targets("mail me@example.com").words).toBe("mail me@example.com");
  });
});
