import { describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";
import { createTeammatePrompts, type TeammatePromptDeps } from "./teammate-prompts.ts";

vi.mock("../peer-roster.ts", () => ({ canManage: () => true }));

const chief = { id: "chief", name: "Clive", chiefOfStaff: true } as BotRecord;
const teammate = { id: "mira", name: "Mira" } as BotRecord;

function questions(fullAccess: boolean): string {
  const deps = {
    store: { bots: [chief, teammate], bot: () => teammate },
    isUnattended: () => false,
    startedOutside: () => false,
    guestDriven: () => false,
    confined: () => false,
    fullAccess: () => fullAccess,
    readableFrom: () => () => true,
    waitingForPerson: () => [{ bot: "Mira", threadId: "t1", thread: "Pricing", question: "Keep the old page?" }],
  } as unknown as TeammatePromptDeps;
  return createTeammatePrompts(deps).questions(chief, "job");
}

describe("what a Chief is told about its teammates' questions", () => {
  it("answers on its own certainty only at Full access", () => {
    expect(questions(true)).toContain("you know the answer for certain");
  });

  it("below Full access answers only when the person gave the answer or asked it to", () => {
    const told = questions(false);
    expect(told).toContain("When the person gives you an answer or asks you to answer one, send it");
    expect(told).not.toContain("for certain");
  });
});
