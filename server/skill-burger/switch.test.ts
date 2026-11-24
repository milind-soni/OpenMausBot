// Settings → Features → Skill Burger, as the server sees it: on unless config.json says false, and off it takes the run
// and edit tools out of every conversation's list.
import { describe, expect, it } from "vitest";

import { agentsServerEnv, type AgentsConversation } from "../agents-turn.ts";
import { parseConfigPatch } from "../config.ts";
import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { WORKFLOW_TOOL_NAMES } from "../drivers/agents-workflow-tool.ts";
import { skillBurgerEnabled } from "./store.ts";

const HOST: AgentsConversation["host"] = { skillAuthoring: true, sharedComputers: false, cloudHome: false, team: false, voiceNotes: false, x: false, research: false, imageGeneration: false, localVm: true };
const CHAT: AgentsConversation = { threadId: "thread-1", bot: { id: "bot-1" }, room: false, teamComputer: false, host: HOST };
const listedFor = (host: AgentsConversation["host"]) =>
  availableTools(catalogProfileFromEnv(agentsServerEnv({ ...CHAT, host }, { generation: "g", depth: 0, skillAuthoring: true }, () => "bearer", "http://127.0.0.1:1")))
    .map((tool) => tool.name);

describe("the Skill Burger switch on the server", () => {
  it("is on unless config.json says false", () => {
    expect(skillBurgerEnabled({})).toBe(true);
    expect(skillBurgerEnabled({ features: {} })).toBe(true);
    expect(skillBurgerEnabled({ features: { skillBurger: true } })).toBe(true);
    expect(skillBurgerEnabled({ features: { skillBurger: false } })).toBe(false);
  });

  it("is a config.json field Settings can patch, with thread tabs beside it", () => {
    expect(parseConfigPatch({ features: { skillBurger: false, threadTabs: true } })).toMatchObject({ features: { skillBurger: false, threadTabs: true } });
  });

  it("offers the run and edit tools while on, and neither once off", () => {
    for (const name of WORKFLOW_TOOL_NAMES) {
      expect(listedFor(HOST)).toContain(name);
      expect(listedFor({ ...HOST, skillBurger: true })).toContain(name);
      expect(listedFor({ ...HOST, skillBurger: false })).not.toContain(name);
    }
    expect(listedFor({ ...HOST, skillBurger: false })).toEqual(listedFor(HOST).filter((name) => !WORKFLOW_TOOL_NAMES.has(name)));
  });

  it("keeps the tools for an agents server started without the switch", () => {
    const names = availableTools(catalogProfileFromEnv({})).map((tool) => tool.name);
    for (const name of WORKFLOW_TOOL_NAMES) expect(names).toContain(name);
  });
});
