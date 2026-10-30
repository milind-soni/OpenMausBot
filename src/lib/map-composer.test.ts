import { describe, expect, it } from "vitest";
import { mapMessageTargets, sentToSummary } from "./map-composer";

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
    expect(mapMessageTargets("start your task", bots, teams)).toEqual({ botIds: [], tags: [], unknown: [] });
  });

  it("summarises who a message went to", () => {
    expect(sentToSummary(["Ana"])).toEqual({ names: ["Ana"], more: 0 });
    expect(sentToSummary(["Ana", "Ben", "Cy"])).toEqual({ names: ["Ana", "Ben", "Cy"], more: 0 });
    expect(sentToSummary(["Ana", "Ben", "Cy", "Dee", "Eve"])).toEqual({ names: ["Ana", "Ben"], more: 3 });
  });
});
