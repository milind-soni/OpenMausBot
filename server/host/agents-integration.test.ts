import { expect, it } from "vitest";

import { createAgentsIntegration } from "./agents-integration.ts";

const host = {
  skillAuthoring: true, sharedComputers: false, cloudHome: false, team: false,
  voiceNotes: false, x: false, research: false, imageGeneration: false,
};

function mount(task: { openedBy?: unknown; botApi?: boolean; routineRunId?: string } | undefined, operator = false) {
  return createAgentsIntegration({
    bot: () => ({ id: "bot-1", computer: "local" }) as never,
    speaking: () => null,
    room: () => false,
    teamComputer: () => false,
    task: () => task,
    host: () => ({ ...host, operator }),
    mint: () => "token",
    port: 9,
    savedFiles: false,
  });
}

it("lists computer selection on a person's chat, and the operator switch only for an appointed bot", () => {
  const person = mount(undefined)("bot-1", "thread-1", 0, true, "gen");
  expect(person.env.OMB_COMPUTER_SELECTION).toBe("1");
  expect(person.env.OMB_CHIEF_OPERATOR).toBe("0");
  expect(mount(undefined, true)("bot-1", "thread-1", 0, true, "gen").env.OMB_CHIEF_OPERATOR).toBe("1");
});

it("keeps computer selection off when a bot or a routine owns the conversation, and on an automated turn of a person's chat", () => {
  const call = (task: { openedBy?: unknown; botApi?: boolean; routineRunId?: string } | undefined, automated = false) =>
    mount(task)("bot-1", "thread-1", 0, true, "gen", undefined, false, automated).env.OMB_COMPUTER_SELECTION;
  expect(call({ openedBy: { botId: "other" } })).toBe("0");
  expect(call({ botApi: true })).toBe("0");
  expect(call({ routineRunId: "run-1" })).toBe("0");
  expect(call(undefined, true)).toBe("0");
  expect(call({})).toBe("1");
});
